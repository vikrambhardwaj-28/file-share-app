const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const convertapi = require('convertapi')('secret_9b5e5894b9981a8b'); // Free API Secret Key

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
        activePins[pin].files.forEach(file => fs.unlink(file.path, () => {}));
        delete activePins[pin];
    }
}

// 1. AirShare Standard Upload
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    activePins[pin] = { files: req.files, expiresAt: Date.now() + 60000, downloadCount: 0, maxDownloads: 3 };
    setTimeout(() => purgeFiles(pin), 60000);
    return res.json({ success: true, pin, fileCount: req.files.length, expiresInSeconds: 60 });
});

// 2. AirFormat Endpoint (Free Multi-Format Engine)
app.post('/convert-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace('.', '').toLowerCase();
        const targetFormat = (req.body.targetFormat || 'pdf').toLowerCase().trim();
        const baseName = path.parse(originalName).name;
        const outputFileName = `${Date.now()}-${baseName}.${targetFormat}`;
        const outputPath = path.join(uploadDir, outputFileName);

        const imageFormats = ['jpg', 'jpeg', 'png', 'webp'];
        if (imageFormats.includes(srcExt) && imageFormats.includes(targetFormat)) {
            let sharpInstance = sharp(inputPath);
            if (targetFormat === 'jpg' || targetFormat === 'jpeg') sharpInstance = sharpInstance.jpeg({ quality: 90 });
            else if (targetFormat === 'png') sharpInstance = sharpInstance.png({ compressionLevel: 8 });
            else if (targetFormat === 'webp') sharpInstance = sharpInstance.webp({ quality: 85 });

            await sharpInstance.toFile(outputPath);
        } else {
            const result = await convertapi.convert(targetFormat, { File: inputPath }, srcExt);
            await result.saveFiles(outputPath);
        }

        fs.unlink(inputPath, () => {});

        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        activePins[pin] = {
            files: [{ path: outputPath, originalname: `${baseName}.${targetFormat}`, size: fs.statSync(outputPath).size }],
            expiresAt: Date.now() + 60000,
            downloadCount: 0,
            maxDownloads: 3
        };

        setTimeout(() => purgeFiles(pin), 60000);
        return res.json({ success: true, pin, expiresInSeconds: 60 });

    } catch (err) {
        console.error('[AirFormat Conversion Error]:', err.message || err);
        return res.status(500).json({ success: false, message: `Conversion Error: ${err.message || 'Processing failed'}` });
    }
});

// 3. AirCompress Endpoint (High-Efficiency Compression)
app.post('/compress-cloud', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

        const inputPath = req.file.path;
        const originalName = req.file.originalname;
        const srcExt = path.extname(originalName).replace('.', '').toLowerCase();
        const baseName = path.parse(originalName).name;
        const outputFileName = `${Date.now()}-compressed-${baseName}.${srcExt}`;
        const outputPath = path.join(uploadDir, outputFileName);

        const imageFormats = ['jpg', 'jpeg', 'png', 'webp'];
        if (imageFormats.includes(srcExt)) {
            let sharpInstance = sharp(inputPath);
            if (srcExt === 'jpg' || srcExt === 'jpeg') sharpInstance = sharpInstance.jpeg({ quality: 60, mozjpeg: true });
            else if (srcExt === 'png') sharpInstance = sharpInstance.png({ quality: 60, compressionLevel: 9 });
            else if (srcExt === 'webp') sharpInstance = sharpInstance.webp({ quality: 55 });

            await sharpInstance.toFile(outputPath);
        } else {
            const result = await convertapi.convert('compress', { File: inputPath }, srcExt);
            await result.saveFiles(outputPath);
        }

        const compressedSize = fs.statSync(outputPath).size;
        fs.unlink(inputPath, () => {});

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

app.get('/api/files/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];
    if (!record || Date.now() > record.expiresAt) return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    return res.json({ success: true, files: record.files.map((file, index) => ({ index, originalname: file.originalname, size: file.size })) });
});

app.get('/download/:pin/:index', (req, res) => {
    const { pin, index } = req.params;
    const record = activePins[pin];
    if (!record || Date.now() > record.expiresAt) return res.status(410).json({ success: false, message: 'Invalid or expired PIN.' });
    const targetFile = record.files[parseInt(index, 10)];
    return res.download(targetFile.path, targetFile.originalname);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));