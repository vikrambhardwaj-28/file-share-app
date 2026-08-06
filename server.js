const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure 'uploads' directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// In-memory store for PIN metadata
const activePins = {};

/**
 * POST /upload
 * Handles file upload, generates a 6-digit PIN, and schedules auto-deletion in 30 seconds.
 */
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    // Generate a secure 6-digit PIN (100000 - 999999)
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDurationMs = 30000; // 30 seconds
    const expiresAt = Date.now() + expiryDurationMs;

    // Save file metadata
    activePins[pin] = {
        filePath: req.file.path,
        originalName: req.file.originalname,
        expiresAt
    };

    // Schedule auto-deletion from disk and memory after 30 seconds
    setTimeout(() => {
        if (activePins[pin]) {
            fs.unlink(activePins[pin].filePath, (err) => {
                if (err && err.code !== 'ENOENT') {
                    console.error(`[Error] Failed to delete file for PIN ${pin}:`, err);
                }
            });
            delete activePins[pin];
            console.log(`[Security Purge] PIN ${pin} and associated file expired.`);
        }
    }, expiryDurationMs);

    return res.json({
        success: true,
        pin,
        expiresInSeconds: 30
    });
});

/**
 * GET /download/:pin
 * Validates 6-digit PIN and serves file download if unexpired.
 */
app.get('/download/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];

    if (!record || Date.now() > record.expiresAt) {
        return res.status(410).json({
            success: false,
            message: 'Invalid or expired PIN. Files are permanently deleted after 30 seconds.'
        });
    }

    return res.download(record.filePath, record.originalName);
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});