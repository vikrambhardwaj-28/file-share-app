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

// Upload directory setup
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});
const upload = multer({ storage });

const activePins = {};

/**
 * Helper to purge active files safely
 */
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
        console.log(`[Security Purge] PIN ${pin} expired and deleted.`);
    }
}

/**
 * POST /upload
 * Accepts multiple files (up to 10), sets 60s timer & max download limit (3 claims)
 */
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }

    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDurationMs = 60000; // 60 seconds
    const expiresAt = Date.now() + expiryDurationMs;

    activePins[pin] = {
        files: req.files,
        expiresAt,
        downloadCount: 0,
        maxDownloads: 3 // Max 3 retrieval sessions allowed before auto-purge
    };

    // Auto-delete after 60 seconds
    setTimeout(() => {
        purgeFiles(pin);
    }, expiryDurationMs);

    return res.json({
        success: true,
        pin,
        fileCount: req.files.length,
        expiresInSeconds: 60
    });
});

/**
 * GET /api/files/:pin
 * Validates PIN & returns metadata list
 */
app.get('/api/files/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];

    if (!record || Date.now() > record.expiresAt) {
        return res.status(410).json({
            success: false,
            message: 'Invalid or expired PIN. Files are permanently deleted after 60 seconds.'
        });
    }

    const fileList = record.files.map((file, index) => ({
        index,
        originalname: file.originalname
    }));

    return res.json({ success: true, files: fileList });
});

/**
 * GET /download/:pin/:index
 * Streams single requested file
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

    // Increment download claim counter on last file index download
    if (fileIdx === record.files.length - 1) {
        record.downloadCount += 1;
        if (record.downloadCount >= record.maxDownloads) {
            setTimeout(() => purgeFiles(pin), 1000); // Purge after max download limit
        }
    }

    return res.download(targetFile.path, targetFile.originalname);
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});