const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware Setup
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Uploads directory check and creation
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Multer Disk Storage Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + file.originalname;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100 MB max file size limit
});

// In-Memory Data Stores
const fileDatabase = {};
const feedbackDatabase = [];

// ------------------- API ROUTES ------------------- //

// 1. Multiple Files Upload Route (Max 20 files at once)
app.post('/upload', upload.array('files', 20), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        // Random 4-digit PIN generate karein
        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        
        fileDatabase[pin] = req.files.map(file => ({
            filePath: file.path,
            originalName: file.originalname,
            size: file.size
        }));

        console.log(`[UPLOAD] PIN: ${pin} | Files: ${req.files.length}`);
        res.json({ pin, count: req.files.length });

    } catch (err) {
        console.error('Upload Error:', err);
        res.status(500).json({ error: 'Server upload failed' });
    }
});

// 2. PIN se Files List Retrieve karne ka Route
app.get('/files/:pin', (req, res) => {
    const pin = req.params.pin;
    const files = fileDatabase[pin];

    if (!files) {
        return res.status(404).json({ error: 'Invalid PIN or files expired' });
    }

    res.json({
        files: files.map((file, index) => ({
            id: index,
            name: file.originalName,
            size: (file.size / (1024 * 1024)).toFixed(2) + ' MB'
        }))
    });
});

// 3. Individual File Download Route
app.get('/download/:pin/:index', (req, res) => {
    const { pin, index } = req.params;
    const files = fileDatabase[pin];

    if (!files || !files[index]) {
        return res.status(404).send('File not found or expired');
    }

    const targetFile = files[index];
    res.download(targetFile.filePath, targetFile.originalName);
});

// 4. Feedback Submit Route
app.post('/feedback', (req, res) => {
    const { message } = req.body;
    if (!message || message.trim() === '') {
        return res.status(400).json({ error: 'Feedback message cannot be empty' });
    }

    const newFeedback = {
        id: Date.now(),
        message: message.trim(),
        timestamp: new Date().toLocaleString()
    };

    feedbackDatabase.push(newFeedback);
    
    console.log('\n================ NEW FEEDBACK RECEIVED ================');
    console.log(`Time: ${newFeedback.timestamp}`);
    console.log(`Message: ${newFeedback.message}`);
    console.log('=======================================================\n');

    res.json({ success: true, message: 'Feedback recorded successfully!' });
});

// Server Start
app.listen(PORT, () => {
    console.log(`\n>>> AirShare Server running at http://localhost:${PORT} <<<`);
});