const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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
 * 1. AirShare Upload
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

    return res.json({
        success: true,
        pin,
        fileCount: req.files.length,
        expiresInSeconds: 60
    });
});

/**
 * 2. AirCompress Endpoint
 */
app.post('/compress', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }

    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDurationMs = 60000;

    // Simulate file compression logic while saving metadata
    activePins[pin] = {
        files: req.files,
        expiresAt: Date.now() + expiryDurationMs,
        downloadCount: 0,
        maxDownloads: 3
    };

    setTimeout(() => purgeFiles(pin), expiryDurationMs);

    return res.json({
        success: true,
        pin,
        fileCount: req.files.length,
        expiresInSeconds: 60
    });
});

/**
 * 3. AirFormat Endpoint
 */
app.post('/format', upload.array('files', 10), (req, res) => {
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

    return res.json({
        success: true,
        pin,
        fileCount: req.files.length,
        expiresInSeconds: 60
    });
});

/**
 * Fetch File Metadata
 */
app.get('/api/files/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];

    if (!record || Date.now() > record.expiresAt) {
        return res.status(410).json({
            success: false,
            message: 'Invalid or expired PIN. Files deleted after 60 seconds.'
        });
    }

    const fileList = record.files.map((file, index) => ({
        index,
        originalname: file.originalname,
        size: file.size
    }));

    return res.json({ success: true, files: fileList });
});

/**
 * Stream Download
 */
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

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});