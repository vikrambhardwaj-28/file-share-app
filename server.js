const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});
const upload = multer({ storage });

const activePins = {};

function purgeFiles(pin) {
    if (activePins[pin]) {
        activePins[pin].files.forEach(file => {
            if (fs.existsSync(file.path)) fs.unlink(file.path, () => {});
        });
        delete activePins[pin];
    }
}

// Standard File Upload
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    activePins[pin] = { files: req.files, expiresAt: Date.now() + 60000, downloadCount: 0, maxDownloads: 3 };
    setTimeout(() => purgeFiles(pin), 60000);
    return res.json({ success: true, pin, fileCount: req.files.length, expiresInSeconds: 60 });
});

// Universal Converter (PDF -> ALL & ALL -> PDF)
app.post('/convert-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace(/^\.+/, '').toLowerCase();
        
        let rawTarget = (req.body.targetFormat || 'pdf').toLowerCase().trim();
        rawTarget = rawTarget.replace(/^\.+/, '');

        const formatMap = {
            'doc': 'docx',
            'ppt': 'pptx',
            'xls': 'xlsx',
            'jpeg': 'jpg'
        };
        const cleanExt = formatMap[rawTarget] || rawTarget;

        const baseName = path.parse(originalName).name;
        const outputFileName = `${Date.now()}-${baseName}.${cleanExt}`;
        const outputPath = path.join(uploadDir, outputFileName);

        const imageFormats = ['jpg', 'jpeg', 'png', 'webp'];

        // 1. Image to Image (Sharp)
        if (imageFormats.includes(srcExt) && imageFormats.includes(cleanExt)) {
            let sharpInstance = sharp(inputPath);
            if (cleanExt === 'jpg' || cleanExt === 'jpeg') sharpInstance = sharpInstance.jpeg({ quality: 90 });
            else if (cleanExt === 'png') sharpInstance = sharpInstance.png({ compressionLevel: 8 });
            else if (cleanExt === 'webp') sharpInstance = sharpInstance.webp({ quality: 85 });
            await sharpInstance.toFile(outputPath);

        // 2. Image to PDF
        } else if (imageFormats.includes(srcExt) && cleanExt === 'pdf') {
            const imgBytes = fs.readFileSync(inputPath);
            const pdfDoc = await PDFDocument.create();
            let img;
            if (srcExt === 'png') img = await pdfDoc.embedPng(imgBytes);
            else img = await pdfDoc.embedJpg(imgBytes);

            const page = pdfDoc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(outputPath, pdfBytes);

        // 3. PDF as Source File Handling
        } else if (srcExt === 'pdf') {

            // A. PDF to Image
            if (imageFormats.includes(cleanExt)) {
                const imgFormatFlag = cleanExt === 'jpg' ? '-jpeg' : `-${cleanExt}`;
                const prefix = path.join(uploadDir, `${Date.now()}-${baseName}`);
                await execPromise(`pdftoppm ${imgFormatFlag} -r 150 -f 1 -l 1 "${inputPath}" "${prefix}"`);
                const generatedFiles = fs.readdirSync(uploadDir).filter(f => f.startsWith(path.basename(prefix)));
                if (generatedFiles.length > 0) {
                    fs.renameSync(path.join(uploadDir, generatedFiles[0]), outputPath);
                } else {
                    throw new Error('PDF to Image extraction failed.');
                }

            // B. PDF to DOCX / DOC
            } else if (cleanExt === 'docx' || cleanExt === 'doc') {
                const pythonCmd = `python3 -c "from pdf2docx import Converter; cv = Converter(r'${inputPath}'); cv.convert(r'${outputPath}'); cv.close()"`;
                await execPromise(pythonCmd);

            // C. PDF to TXT
            } else if (cleanExt === 'txt') {
                await execPromise(`pdftotext "${inputPath}" "${outputPath}"`);

            // D. PDF to CSV
            } else if (cleanExt === 'csv') {
                const pyScript = `import pdfplumber, csv
with pdfplumber.open(r'${inputPath}') as pdf, open(r'${outputPath}', 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                writer.writerow([(cell or '').replace('\\n', ' ') for cell in row])
        if not tables:
            text = page.extract_text()
            if text:
                for line in text.split('\\n'):
                    writer.writerow([line])
`;
                const scriptPath = path.join(uploadDir, `extract_${Date.now()}.py`);
                fs.writeFileSync(scriptPath, pyScript);
                await execPromise(`python3 "${scriptPath}"`);
                if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

            // E. PDF to XLSX
            } else if (cleanExt === 'xlsx') {
                const pyScript = `import pdfplumber, openpyxl
wb = openpyxl.Workbook()
ws = wb.active
with pdfplumber.open(r'${inputPath}') as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                ws.append([(cell or '').replace('\\n', ' ') for cell in row])
        if not tables:
            text = page.extract_text()
            if text:
                for line in text.split('\\n'):
                    ws.append([line])
wb.save(r'${outputPath}')
`;
                const scriptPath = path.join(uploadDir, `extract_${Date.now()}.py`);
                fs.writeFileSync(scriptPath, pyScript);
                await execPromise(`python3 "${scriptPath}"`);
                if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

            // F. PDF to ODT / PPTX / HTML (Chained Conversion: PDF -> DOCX -> Target)
            } else {
                const tempDocxPath = path.join(uploadDir, `temp-${Date.now()}.docx`);
                const pythonCmd = `python3 -c "from pdf2docx import Converter; cv = Converter(r'${inputPath}'); cv.convert(r'${tempDocxPath}'); cv.close()"`;
                await execPromise(pythonCmd);

                const tempOutDir = path.join(uploadDir, `conv-${Date.now()}`);
                fs.mkdirSync(tempOutDir, { recursive: true });
                await execPromise(`soffice --headless --convert-to ${cleanExt} "${tempDocxPath}" --outdir "${tempOutDir}"`);

                const files = fs.readdirSync(tempOutDir);
                if (files.length > 0) {
                    fs.renameSync(path.join(tempOutDir, files[0]), outputPath);
                }
                if (fs.existsSync(tempDocxPath)) fs.unlinkSync(tempDocxPath);
                fs.rmdirSync(tempOutDir, { recursive: true });
            }

        // 4. All Other Documents (DOCX, PPTX, XLSX, ODT, TXT, CSV) to PDF / Other Formats
        } else {
            const tempOutDir = path.join(uploadDir, `conv-${Date.now()}`);
            fs.mkdirSync(tempOutDir, { recursive: true });

            const cmd = `soffice --headless --convert-to ${cleanExt} "${inputPath}" --outdir "${tempOutDir}"`;
            await execPromise(cmd);

            const files = fs.readdirSync(tempOutDir);
            if (files.length === 0) {
                fs.rmdirSync(tempOutDir, { recursive: true });
                throw new Error(`Could not convert .${srcExt} to .${cleanExt}`);
            }

            const convertedFilePath = path.join(tempOutDir, files[0]);
            fs.renameSync(convertedFilePath, outputPath);
            fs.rmdirSync(tempOutDir, { recursive: true });
        }

        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        activePins[pin] = {
            files: [{ path: outputPath, originalname: `${baseName}.${cleanExt}`, size: fs.statSync(outputPath).size }],
            expiresAt: Date.now() + 60000,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), 60000);
        return res.json({ success: true, pin, expiresInSeconds: 60 });

    } catch (err) {
        console.error('[AirFormat Conversion Error]:', err.message || err);
        return res.status(500).json({ success: false, message: `Conversion failed: ${err.message || 'Processing error'}` });
    }
});

// Fast File Compression Engine
app.post('/compress-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace(/^\.+/, '').toLowerCase();
        const baseName = path.parse(originalName).name;
        const outputFileName = `${Date.now()}-compressed-${baseName}.${srcExt}`;
        const outputPath = path.join(uploadDir, outputFileName);

        const imageFormats = ['jpg', 'jpeg', 'png', 'webp'];
        if (imageFormats.includes(srcExt)) {
            let sharpInstance = sharp(inputPath);
            if (srcExt === 'jpg' || srcExt === 'jpeg') sharpInstance = sharpInstance.jpeg({ quality: 50, mozjpeg: true });
            else if (srcExt === 'png') sharpInstance = sharpInstance.png({ quality: 50, compressionLevel: 9 });
            else if (srcExt === 'webp') sharpInstance = sharpInstance.webp({ quality: 50 });

            await sharpInstance.toFile(outputPath);
        } else {
            const tempOutDir = path.join(uploadDir, `comp-${Date.now()}`);
            fs.mkdirSync(tempOutDir, { recursive: true });
            await execPromise(`soffice --headless --convert-to pdf "${inputPath}" --outdir "${tempOutDir}"`);
            const files = fs.readdirSync(tempOutDir);
            if (files.length > 0) fs.renameSync(path.join(tempOutDir, files[0]), outputPath);
            fs.rmdirSync(tempOutDir, { recursive: true });
        }

        const compressedSize = fs.statSync(outputPath).size;
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        activePins[pin] = {
            files: [{ path: outputPath, originalname: `${baseName}-compressed.${srcExt}`, size: compressedSize }],
            expiresAt: Date.now() + 60000,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), 60000);
        return res.json({ success: true, pin, originalSize: req.file.size, compressedSize, expiresInSeconds: 60 });

    } catch (err) {
        console.error('[AirCompress Error]:', err.message || err);
        return res.status(500).json({ success: false, message: 'Compression failed.' });
    }
});

// File Info API
app.get('/api/files/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];
    if (!record || Date.now() > record.expiresAt) return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    return res.json({ success: true, files: record.files.map((file, index) => ({ index, originalname: file.originalname, size: file.size })) });
});

// Download File
app.get('/download/:pin/:index', (req, res) => {
    const { pin, index } = req.params;
    const record = activePins[pin];
    if (!record || Date.now() > record.expiresAt) return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    const targetFile = record.files[parseInt(index, 10)];
    return res.download(targetFile.path, targetFile.originalname);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));