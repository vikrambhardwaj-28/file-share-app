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
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});
const upload = multer({ storage });

const activePins = new Map();

const purgeFiles = (pin) => {
    const session = activePins.get(pin);
    if (!session) return;

    if (session.timeoutId) {
        clearTimeout(session.timeoutId);
    }

    session.files.forEach(file => {
        if (file.path && fs.existsSync(file.path)) {
            fs.unlink(file.path, () => {});
        }
    });

    activePins.delete(pin);
};

const createSession = (files) => {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const timeoutId = setTimeout(() => purgeFiles(pin), 60000);

    activePins.set(pin, {
        files,
        expiresAt: Date.now() + 60000,
        downloadCount: 0,
        maxDownloads: 3,
        timeoutId
    });

    return pin;
};

app.post('/upload', upload.array('files', 10), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'No files uploaded.' });
        }

        const pin = createSession(req.files);
        return res.status(200).json({ success: true, pin, fileCount: req.files.length, expiresInSeconds: 60 });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Upload processing failed.' });
    }
});

app.post('/convert-cloud', upload.single('file'), async (req, res) => {
    let inputPath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }

        inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace(/^\.+/, '').toLowerCase();
        
        let rawTarget = (req.body.targetFormat || 'pdf').toLowerCase().trim().replace(/^\.+/, '');
        const formatMap = { doc: 'docx', ppt: 'pptx', xls: 'xlsx', jpeg: 'jpg' };
        const cleanExt = formatMap[rawTarget] || rawTarget;

        const baseName = path.parse(originalName).name;
        const outputFileName = `${Date.now()}-${baseName}.${cleanExt}`;
        const outputPath = path.join(uploadDir, outputFileName);
        const imageFormats = ['jpg', 'jpeg', 'png', 'webp'];

        if (imageFormats.includes(srcExt) && imageFormats.includes(cleanExt)) {
            let sharpInstance = sharp(inputPath);
            if (cleanExt === 'jpg' || cleanExt === 'jpeg') {
                sharpInstance = sharpInstance.jpeg({ quality: 90 });
            } else if (cleanExt === 'png') {
                sharpInstance = sharpInstance.png({ compressionLevel: 8 });
            } else if (cleanExt === 'webp') {
                sharpInstance = sharpInstance.webp({ quality: 85 });
            }
            await sharpInstance.toFile(outputPath);

        } else if (imageFormats.includes(srcExt) && cleanExt === 'pdf') {
            const imgBytes = fs.readFileSync(inputPath);
            const pdfDoc = await PDFDocument.create();
            const img = (srcExt === 'png') 
                ? await pdfDoc.embedPng(imgBytes) 
                : await pdfDoc.embedJpg(imgBytes);

            const page = pdfDoc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(outputPath, pdfBytes);

        } else if (srcExt === 'pdf') {
            if (imageFormats.includes(cleanExt)) {
                const imgFormatFlag = cleanExt === 'jpg' ? '-jpeg' : `-${cleanExt}`;
                const prefix = path.join(uploadDir, `${Date.now()}-${baseName}`);
                await execPromise(`pdftoppm ${imgFormatFlag} -r 150 -f 1 -l 1 "${inputPath}" "${prefix}"`);
                
                const generatedFiles = fs.readdirSync(uploadDir).filter(f => f.startsWith(path.basename(prefix)));
                if (!generatedFiles.length) {
                    throw new Error('PDF to Image extraction failed.');
                }
                fs.renameSync(path.join(uploadDir, generatedFiles[0]), outputPath);

            } else if (cleanExt === 'docx' || cleanExt === 'doc') {
                const pythonCmd = `python3 -c "from pdf2docx import Converter; cv = Converter(r'${inputPath}'); cv.convert(r'${outputPath}'); cv.close()"`;
                await execPromise(pythonCmd);

            } else if (cleanExt === 'txt') {
                await execPromise(`pdftotext "${inputPath}" "${outputPath}"`);

            } else if (cleanExt === 'csv' || cleanExt === 'xlsx') {
                const isExcel = cleanExt === 'xlsx';
                const pyScript = isExcel
                    ? `import pdfplumber, openpyxl\nwb = openpyxl.Workbook()\nws = wb.active\nwith pdfplumber.open(r'${inputPath}') as pdf:\n    for page in pdf.pages:\n        tables = page.extract_tables()\n        for table in tables:\n            for row in table:\n                ws.append([(cell or '').replace('\\n', ' ') for cell in row])\n        if not tables:\n            text = page.extract_text()\n            if text:\n                for line in text.split('\\n'):\n                    ws.append([line])\nwb.save(r'${outputPath}')`
                    : `import pdfplumber, csv\nwith pdfplumber.open(r'${inputPath}') as pdf, open(r'${outputPath}', 'w', newline='', encoding='utf-8') as f:\n    writer = csv.writer(f)\n    for page in pdf.pages:\n        tables = page.extract_tables()\n        for table in tables:\n            for row in table:\n                writer.writerow([(cell or '').replace('\\n', ' ') for cell in row])\n        if not tables:\n            text = page.extract_text()\n            if text:\n                for line in text.split('\\n'):\n                    writer.writerow([line])`;

                const scriptPath = path.join(uploadDir, `extract_${Date.now()}.py`);
                fs.writeFileSync(scriptPath, pyScript);
                await execPromise(`python3 "${scriptPath}"`);
                if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

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

        } else {
            const tempOutDir = path.join(uploadDir, `conv-${Date.now()}`);
            fs.mkdirSync(tempOutDir, { recursive: true });

            await execPromise(`soffice --headless --convert-to ${cleanExt} "${inputPath}" --outdir "${tempOutDir}"`);

            const files = fs.readdirSync(tempOutDir);
            if (!files.length) {
                fs.rmdirSync(tempOutDir, { recursive: true });
                throw new Error(`Could not convert .${srcExt} to .${cleanExt}`);
            }

            fs.renameSync(path.join(tempOutDir, files[0]), outputPath);
            fs.rmdirSync(tempOutDir, { recursive: true });
        }

        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

        const pin = createSession([{
            path: outputPath,
            originalname: `${baseName}.${cleanExt}`,
            size: fs.statSync(outputPath).size
        }]);

        return res.status(200).json({ success: true, pin, expiresInSeconds: 60 });

    } catch (err) {
        if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        return res.status(500).json({ success: false, message: `Conversion failed: ${err.message || 'Processing error'}` });
    }
});

app.post('/compress-cloud', upload.single('file'), async (req, res) => {
    let inputPath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }

        inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace(/^\.+/, '').toLowerCase();
        const baseName = path.parse(originalName).name;
        const outputFileName = `${Date.now()}-compressed-${baseName}.${srcExt}`;
        const outputPath = path.join(uploadDir, outputFileName);

        let targetQuality = parseInt(req.body.targetQuality || '50', 10);
        targetQuality = Math.max(10, Math.min(90, isNaN(targetQuality) ? 50 : targetQuality));

        const imageFormats = ['jpg', 'jpeg', 'png', 'webp'];
        if (imageFormats.includes(srcExt)) {
            let sharpInstance = sharp(inputPath);
            if (srcExt === 'jpg' || srcExt === 'jpeg') {
                sharpInstance = sharpInstance.jpeg({ quality: targetQuality, mozjpeg: true });
            } else if (srcExt === 'png') {
                const pngLevel = Math.max(1, Math.min(9, Math.round(9 - (targetQuality / 10))));
                sharpInstance = sharpInstance.png({ quality: targetQuality, compressionLevel: pngLevel });
            } else if (srcExt === 'webp') {
                sharpInstance = sharpInstance.webp({ quality: targetQuality });
            }
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

        const pin = createSession([{
            path: outputPath,
            originalname: `${baseName}-compressed.${srcExt}`,
            size: compressedSize
        }]);

        return res.status(200).json({
            success: true,
            pin,
            originalSize: req.file.size,
            compressedSize,
            expiresInSeconds: 60
        });

    } catch (err) {
        if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        return res.status(500).json({ success: false, message: 'Compression failed.' });
    }
});

app.get('/api/files/:pin', (req, res) => {
    const { pin } = req.params;
    const session = activePins.get(pin);

    if (!session || Date.now() > session.expiresAt) {
        return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    }

    return res.status(200).json({
        success: true,
        files: session.files.map((file, index) => ({
            index,
            originalname: file.originalname,
            size: file.size
        }))
    });
});

app.get('/download/:pin/:index', (req, res) => {
    const { pin, index } = req.params;
    const session = activePins.get(pin);

    if (!session || Date.now() > session.expiresAt) {
        return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    }

    const targetFile = session.files[parseInt(index, 10)];
    if (!targetFile || !fs.existsSync(targetFile.path)) {
        return res.status(404).json({ success: false, message: 'File not found.' });
    }

    return res.download(targetFile.path, targetFile.originalname);
});

app.listen(PORT, () => {
    console.log(`Application running on http://localhost:${PORT}`);
});