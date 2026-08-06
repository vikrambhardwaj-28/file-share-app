const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
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

// In-memory object to store active PIN metadata
const activePins = {};

/**
 * POST /upload
 * Accepts multiple files (up to 10) under the field 'files'.
 * Generates a 6-digit PIN valid for exactly 60 seconds.
 */
app.post('/upload', upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'No files uploaded.' });
    }

    // Generate a 6-digit random security PIN
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryDurationMs = 60000; // 60 seconds
    const expiresAt = Date.now() + expiryDurationMs;

    // Save metadata in RAM
    activePins[pin] = {
        files: req.files,
        expiresAt
    };

    // Auto-purge files from disk and RAM after 60 seconds
    setTimeout(() => {
        if (activePins[pin]) {
            activePins[pin].files.forEach(file => {
                fs.unlink(file.path, (err) => {
                    if (err && err.code !== 'ENOENT') {
                        console.error(`[Error] Failed to delete file ${file.path}:`, err);
                    }
                });
            });
            delete activePins[pin];
            console.log(`[Security Purge] PIN ${pin} and associated files deleted.`);
        }
    }, expiryDurationMs);

    return res.json({
        success: true,
        pin,
        fileCount: req.files.length,
        expiresInSeconds: 60
    });
});

/**
 * GET /download/:pin
 * Validates PIN. Serves single file or archives multiple files into a ZIP stream.
 */
app.get('/download/:pin', (req, res) => {
    const { pin } = req.params;
    const record = activePins[pin];

    // Return 410 status if PIN is invalid or expired
    if (!record || Date.now() > record.expiresAt) {
        return res.status(410).json({
            success: false,
            message: 'Invalid or expired PIN. Files are permanently deleted after 60 seconds.'
        });
    }

    // Single file download
    if (record.files.length === 1) {
        const singleFile = record.files[0];
        return res.download(singleFile.path, singleFile.originalname);
    }

    // Multiple files zipped download
    res.attachment('AirShare-Files.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
    });

    archive.pipe(res);

    record.files.forEach(file => {
        archive.file(file.path, { name: file.originalname });
    });

    archive.finalize();
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});