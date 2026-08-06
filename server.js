const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

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
            fs.unlink(file.path, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error(`[Error] Deleting ${file.path}:`, err);
                }
            });
        });
        delete activePins[pin];
        console.log(`[Purge] PIN ${pin} expired and purged.`);
    }
}

/**
 * AirShare - Multi Upload
 */
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }

    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDurationMs = 60000;

    activePins[pin] = {
        files: req.files,
        expiresAt: Date.now() + expiryDurationMs,
        downloadCount: 0,
        maxDownloads: 3
    };

    setTimeout(() => purgeFiles(pin), expiryDurationMs);
    return res.json({ success: true, pin, fileCount: req.files.length, expiresInSeconds: 60 });
});

/**
 * AirCompress - REAL Image Dimensions & Quality Reduction
 */
app.post('/compress', upload.array('files', 1), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const originalFile = req.files[0];
    const ext = path.extname(originalFile.originalname).toLowerCase();
    const baseName = path.parse(originalFile.originalname).name;
    const compressedFileName = `${Date.now()}-comp-${baseName}${ext}`;
    const compressedPath = path.join(uploadDir, compressedFileName);

    try {
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            // High compression using scale resize and lossy quality
            let pipeline = sharp(originalFile.path).resize({ width: 1000, withoutEnlargement: true });
            
            if (ext === '.jpg' || ext === '.jpeg') {
                await pipeline.jpeg({ quality: 25, progressive: true }).toFile(compressedPath);
            } else if (ext === '.png') {
                await pipeline.png({ quality: 25, compressionLevel: 9 }).toFile(compressedPath);
            } else if (ext === '.webp') {
                await pipeline.webp({ quality: 25 }).toFile(compressedPath);
            }
        } else {
            // Fallback for non-image files
            fs.copyFileSync(originalFile.path, compressedPath);
        }

        fs.unlink(originalFile.path, () => {});

        const compressedSize = fs.statSync(compressedPath).size;
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const expiryDurationMs = 60000;

        activePins[pin] = {
            files: [{
                path: compressedPath,
                originalname: `${baseName}-compressed${ext}`,
                size: compressedSize
            }],
            expiresAt: Date.now() + expiryDurationMs,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), expiryDurationMs);

        return res.json({
            success: true,
            pin,
            originalSize: originalFile.size,
            compressedSize: compressedSize,
            expiresInSeconds: 60
        });

    } catch (err) {
        console.error('Compress Error:', err);
        return res.status(500).json({ success: false, message: 'Compression failed.' });
    }
});

/**
 * AirFormat - REAL Binary Conversion (Image to Image / Image to PDF)
 */
app.post('/format', upload.array('files', 1), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const originalFile = req.files[0];
    const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase().trim();
    const baseName = path.parse(originalFile.originalname).name;
    const newFileName = `${Date.now()}-${baseName}.${targetFormat}`;
    const newFilePath = path.join(uploadDir, newFileName);

    try {
        const srcExt = path.extname(originalFile.originalname).toLowerCase();

        // 1. Image to Image Conversion (PNG <-> JPG <-> WEBP)
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(srcExt) && ['jpg', 'jpeg', 'png', 'webp'].includes(targetFormat)) {
            let pipeline = sharp(originalFile.path);
            if (targetFormat === 'jpg' || targetFormat === 'jpeg') {
                await pipeline.toFormat('jpeg').toFile(newFilePath);
            } else if (targetFormat === 'png') {
                await pipeline.toFormat('png').toFile(newFilePath);
            } else if (targetFormat === 'webp') {
                await pipeline.toFormat('webp').toFile(newFilePath);
            }
        } 
        // 2. Image (JPG/PNG) -> Valid Printable PDF Conversion
        else if (['.jpg', '.jpeg', '.png'].includes(srcExt) && targetFormat === 'pdf') {
            const pdfDoc = await PDFDocument.create();
            const imageBytes = fs.readFileSync(originalFile.path);
            
            let img = (srcExt === '.png') 
                ? await pdfDoc.embedPng(imageBytes) 
                : await pdfDoc.embedJpg(imageBytes);

            const page = pdfDoc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(newFilePath, pdfBytes);
        }
        // 3. Text to PDF or TXT Conversion
        else if (srcExt === '.txt' && targetFormat === 'pdf') {
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage([600, 800]);
            const textContent = fs.readFileSync(originalFile.path, 'utf8');
            page.drawText(textContent.slice(0, 1000), { x: 50, y: 700, size: 12 });
            const pdfBytes = await pdfDoc.save();
            fs.writeFileSync(newFilePath, pdfBytes);
        }
        else {
            return res.status(400).json({ 
                success: false, 
                message: `Conversion from ${srcExt} to .${targetFormat} is not directly supported.` 
            });
        }

        fs.unlink(originalFile.path, () => {});

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const expiryDurationMs = 60000;

        activePins[pin] = {
            files: [{
                path: newFilePath,
                originalname: `${baseName}.${targetFormat}`,
                size: fs.statSync(newFilePath).size
            }],
            expiresAt: Date.now() + expiryDurationMs,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), expiryDurationMs);

        return res.json({ success: true, pin, targetFormat, expiresInSeconds: 60 });

    } catch (err) {
        console.error('Format Error:', err);
        return res.status(500).json({ success: false, message: 'Format conversion failed.' });
    }
});

app.get('/api/files/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];

    if (!record || Date.now() > record.expiresAt) {
        return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    }

    const fileList = record.files.map((file, index) => ({
        index,
        originalname: file.originalname,
        size: file.size
    }));

    return res.json({ success: true, files: fileList });
});

app.get('/download/:pin/:index', (req, res) => {
    const { pin, index } = req.params;
    const record = activePins[pin];

    if (!record || Date.now() > record.expiresAt) {
        return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    }

    const fileIdx = parseInt(index, 10);
    const targetFile = record.files[fileIdx];

    if (!targetFile) {
        return res.status(404).json({ success: false, message: 'File not found.' });
    }

    if (fileIdx === record.files.length - 1) {
        record.downloadCount += 1;
        if (record.downloadCount >= record.maxDownloads) {
            setTimeout(() => purgeFiles(pin), 1000);
        }
    }

    return res.download(targetFile.path, targetFile.originalname);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));