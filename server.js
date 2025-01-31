const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Google Sheets Setup
async function getSheet() {
    try {
        console.log('Initializing Google Sheets connection...');
        const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
            key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        console.log('Google Sheets connection established successfully');
        return doc.sheetsByIndex[0];
    } catch (error) {
        console.error('Error connecting to Google Sheets:', error);
        throw error;
    }
}
async function getSheetEvolve() {
    try {
        console.log('Initializing Google Sheets connection...');
        const serviceAccountAuth = new JWT({
            email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
            key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_SHEET_ID_EVOLVE, serviceAccountAuth);
        await doc.loadInfo();
        console.log('Google Sheets connection established successfully');
        return doc.sheetsByIndex[0];
    } catch (error) {
        console.error('Error connecting to Google Sheets:', error);
        throw error;
    }
}

// Email Configuration

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD  // Use App Password, not regular Gmail password
    }
});

// PhonePe Payment Gateway
class PhonePeClient {
    constructor() {
        this.merchantId = process.env.PHONEPE_MID;
        this.saltKey = process.env.PHONEPE_SALTKEY;
        this.saltIndex = 1;
        // Ensure the API URL ends without a trailing slash
        this.apiUrl = process.env.PHONEPE_API_URL ? process.env.PHONEPE_API_URL.replace(/\/$/, '') : '';
        console.log('PhonePe Client initialized with API URL:', this.apiUrl);
    }

    generateChecksum(payload, apiEndpoint) {
        console.log('Generating checksum with payload:', JSON.stringify(payload));
        const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
        const string = `${base64Payload}${apiEndpoint}${this.saltKey}`;
        const checksum = `${crypto.createHash('sha256').update(string).digest('hex')}###${this.saltIndex}`;
        console.log('Generated checksum:', checksum);
        return checksum;
    }

    async initiatePayment(paymentData) {
        try {
            console.log('Initiating PhonePe payment with data:', JSON.stringify(paymentData));
            
            if (!this.merchantId || !this.saltKey || !this.apiUrl) {
                throw new Error('Missing required PhonePe configuration');
            }

            const payload = {
                merchantId: this.merchantId,
                merchantTransactionId: paymentData.orderId,
                merchantUserId: paymentData.email.replace('@', '_'),
                amount: Math.round(paymentData.amount * 100),
                redirectUrl: `${process.env.BACKEND_URL}/api/verify`,
                redirectMode: "POST",
                callbackUrl: `${process.env.BACKEND_URL}${paymentData.callbackURL}`,
                mobileNumber: paymentData.phone,
                paymentInstrument: {
                    type: "PAY_PAGE"
                }
            };

            console.log('Constructed payload:', JSON.stringify(payload));
            
            // The API endpoint should be "/pg/v1/pay"
            const apiEndpoint = "/pg/v1/pay";
            const checksum = this.generateChecksum(payload, apiEndpoint);
            
            // Construct the full URL properly
            const fullUrl = `${this.apiUrl}${apiEndpoint}`;
            console.log('Making request to:', fullUrl);

            const requestBody = {
                request: Buffer.from(JSON.stringify(payload)).toString('base64')
            };
            
            console.log('Request body:', JSON.stringify(requestBody));
            console.log('Request headers:', {
                'Content-Type': 'application/json',
                'X-VERIFY': checksum,
                'Accept': 'application/json'
            });

            const response = await fetch(fullUrl, {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'X-VERIFY': checksum,
                    'Accept': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            console.log('Response status:', response.status);
            const data = await response.json();
            console.log('PhonePe API response:', JSON.stringify(data));

            if (!data.success) {
                console.error('Payment initialization failed:', data);
                throw new Error(`Payment initialization failed: ${data.code} - ${data.message || 'Unknown error'}`);
            }

            return data;
        } catch (error) {
            console.error('Error in initiatePayment:', error);
            throw error;
        }
    }
}
// Check Registration Endpoint
app.post('/api/check-registration', async (req, res) => {
    try {
        const { email, phone } = req.body;
        console.log(`Checking registration for email: ${email}, phone: ${phone}`);
        
        const sheet = await getSheet();
        const rows = await sheet.getRows();
        
        const existingUser = rows.find(row => 
            row.get('email') === email || row.get('phone') === phone
        );

        if (existingUser) {
            console.log('User already registered', { email, phone });
            return res.status(400).json({
                error: 'Already registered',
                message: 'This email or phone number is already registered'
            });
        }

        console.log('Registration check passed', { email, phone });
        res.json({ success: true });
    } catch (error) {
        console.error('Registration check error', error);
        res.status(500).json({ error: 'Server error', message: error.message });
    }
});
app.post('/api/check-registration-evolve', async (req, res) => {
    try {
        const { email, phone } = req.body;
        console.log(`Checking registration for email: ${email}, phone: ${phone}`);
        
        const sheet = await getSheetEvolve();
        const rows = await sheet.getRows();
        
        const existingUser = rows.find(row => 
            row.get('email') === email || row.get('phone') === phone
        );

        if (existingUser) {
            console.log('User already registered', { email, phone });
            return res.status(400).json({
                error: 'Already registered',
                message: 'This email or phone number is already registered'
            });
        }

        console.log('Registration check passed', { email, phone });
        res.json({ success: true });
    } catch (error) {
        console.error('Registration check error', error);
        res.status(500).json({ error: 'Server error', message: error.message });
    }
});


// Initialize Payment
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, amount, packageType } = req.body;
        console.log('Registration request received', { name, email, phone, packageType });
        
        const orderId = `ORDER_${Date.now()}`;
        const ticketNumber = `TICKET_${Date.now()}`;

        // Store registration data
        global.pendingRegistrations = global.pendingRegistrations || new Map();
        global.pendingRegistrations.set(orderId, {
            name, email, phone, 
            package: packageType,
            ticketNumber,
            amount,
            timestamp: new Date().toISOString()
        });

        console.log('Pending registration created', { orderId, ticketNumber });

        // Initialize payment
        const phonePe = new PhonePeClient();
        const callbackURL = "/api/payment-callback"

        const paymentData = { orderId, email, amount, phone, callbackURL };
        const paymentResponse = await phonePe.initiatePayment(paymentData);

        console.log('Payment initialization complete', { 
            paymentUrl: paymentResponse.data.instrumentResponse.redirectInfo.url, 
            orderId, 
            ticketNumber 
        });

        res.json({
            success: true,
            paymentUrl: paymentResponse.data.instrumentResponse.redirectInfo.url,
            orderId,
            ticketNumber
        });

    } catch (error) {
        console.error('Registration failed', error);
        res.status(500).json({ error: 'Registration failed', message: error.message });
    }
});
app.post('/api/register-evolve', async (req, res) => {
    try {
        const { name, email, phone, amount, packageType } = req.body;
        console.log('Registration request received', { name, email, phone, packageType });
        
        const orderId = `ORDER_${Date.now()}`;
        const ticketNumber = `TICKET_${Date.now()}`;

        // Store registration data
        global.pendingRegistrations = global.pendingRegistrations || new Map();
        global.pendingRegistrations.set(orderId, {
            name, email, phone, 
            package: packageType,
            ticketNumber,
            amount,
            timestamp: new Date().toISOString()
        });

        console.log('Pending registration created', { orderId, ticketNumber });

        // Initialize payment
        const phonePe = new PhonePeClient();
        const callbackURL = "/api/payment-callback-evolve"
        const paymentData = { orderId, email, amount, phone, callbackURL };
        const paymentResponse = await phonePe.initiatePayment(paymentData);

        console.log('Payment initialization complete', { 
            paymentUrl: paymentResponse.data.instrumentResponse.redirectInfo.url, 
            orderId, 
            ticketNumber 
        });

        res.json({
            success: true,
            paymentUrl: paymentResponse.data.instrumentResponse.redirectInfo.url,
            orderId,
            ticketNumber
        });

    } catch (error) {
        console.error('Registration failed', error);
        res.status(500).json({ error: 'Registration failed', message: error.message });
    }
});

// Payment Callback
app.post('/api/payment-callback', async (req, res) => {
    try {
        console.log("Full Callback Request Body:", JSON.stringify(req.body, null, 2));
        
        // Decode the base64 response
        const decodedResponse = JSON.parse(Buffer.from(req.body.response, 'base64').toString('utf-8'));
        console.log('Decoded Response:', JSON.stringify(decodedResponse, null, 2));

        // Extract transaction details from decoded response
        const merchantTransactionId = decodedResponse.data.merchantTransactionId;
        const status = decodedResponse.code === 'PAYMENT_SUCCESS' ? 'success' : 'failed';
        
        console.log('Payment callback received', { merchantTransactionId, status });

        // Verify checksum (you'll need to implement this method in PhonePeClient)
        const phonePe = new PhonePeClient();
        const isChecksumValid = phonePe.verifyChecksum(req.headers['x-verify'], req.body.response);
        
        if (!isChecksumValid) {
            console.error('Checksum verification failed');
            return res.status(400).json({ error: 'Invalid callback' });
        }

        const registrationData = global.pendingRegistrations.get(merchantTransactionId);

        if (!registrationData) {
            console.error('Registration data not found', { merchantTransactionId });
            return res.status(404).json({ error: 'Registration data not found' });
        }

        // Send email for both success and failure scenarios
        const emailSubject = status === 'success' 
            ? 'Registration Successful - Trading Summit'
            : 'Registration Failed - Trading Summit';

        const emailHtml = status === 'success'
            ? `
                <h1>Registration Successful!</h1>
                <p>Dear ${registrationData.name},</p>
                <p>Your registration is confirmed.</p>
                <p>Ticket Number: ${registrationData.ticketNumber}</p>
                <p>Package: ${registrationData.package}</p>
            `
            : `
                <h1>Registration Failed</h1>
                <p>Dear ${registrationData.name},</p>
                <p>Your registration payment was unsuccessful.</p>
                <p>Please try again or contact support.</p>
            `;

        // Send email
        console.log(`Sending ${status} email to ${registrationData.email}`);
        await transporter.sendMail({
            from: process.env.SMTP_EMAIL,
            to: registrationData.email,
            subject: emailSubject,
            html: emailHtml
        });
        console.log('Email sent successfully');

        // Add to sheet only if payment is successful
        if (status === 'success') {
            const sheet = await getSheet();
            await sheet.addRow({
                ...registrationData,
                paymentStatus: 'Success',
                orderId: merchantTransactionId
            });
            console.log('Registration added to Google Sheet');
        }

        global.pendingRegistrations.delete(merchantTransactionId);
        console.log('Pending registration cleaned up');
        
        res.json({ success: true, status });

    } catch (error) {
        console.error('Callback processing failed', error);
        res.status(500).json({ error: 'Callback processing failed', message: error.message });
    }
});
app.post('/api/payment-callback-evolve', async (req, res) => {
    try {
        console.log("Full Callback Request Body:", JSON.stringify(req.body, null, 2));
        
        // Decode the base64 response
        const decodedResponse = JSON.parse(Buffer.from(req.body.response, 'base64').toString('utf-8'));
        console.log('Decoded Response:', JSON.stringify(decodedResponse, null, 2));

        // Extract transaction details from decoded response
        const merchantTransactionId = decodedResponse.data.merchantTransactionId;
        const status = decodedResponse.code === 'PAYMENT_SUCCESS' ? 'success' : 'failed';
        
        console.log('Payment callback received', { merchantTransactionId, status });

        // Verify checksum (you'll need to implement this method in PhonePeClient)
        const phonePe = new PhonePeClient();
        const isChecksumValid = phonePe.verifyChecksum(req.headers['x-verify'], req.body.response);
        
        if (!isChecksumValid) {
            console.error('Checksum verification failed');
            return res.status(400).json({ error: 'Invalid callback' });
        }

        const registrationData = global.pendingRegistrations.get(merchantTransactionId);

        if (!registrationData) {
            console.error('Registration data not found', { merchantTransactionId });
            return res.status(404).json({ error: 'Registration data not found' });
        }

        // Send email for both success and failure scenarios
        const emailSubject = status === 'success' 
            ? 'Registration Successful - Evolve 2025'
            : 'Registration Failed - Evolve 2025';

        const emailHtml = status === 'success'
            ? `
                <h1>Registration Successful!</h1>
                <p>Dear ${registrationData.name},</p>
                <p>Your registration is confirmed.</p>
                <p>Ticket Number: ${registrationData.ticketNumber}</p>
                 <p>Order Number: ${registrationData.orderId}</p>
                <p>Package: ${registrationData.package}</p>
            `
            : `
                <h1>Registration Failed</h1>
                <p>Dear ${registrationData.name},</p>
                <p>Your registration payment was unsuccessful.</p>
                <p>Please try again or contact support.</p>
            `;

        // Send email
        console.log(`Sending ${status} email to ${registrationData.email}`);
        await transporter.sendMail({
            from: process.env.SMTP_EMAIL,
            to: registrationData.email,
            subject: emailSubject,
            html: emailHtml
        });
        console.log('Email sent successfully');

        // Add to sheet only if payment is successful
        if (status === 'success') {
            const sheet = await getSheetEvolve();
            await sheet.addRow({
                ...registrationData,
                paymentStatus: 'Success',
                orderId: merchantTransactionId
            });
            console.log('Registration added to Google Sheet');
        }

        global.pendingRegistrations.delete(merchantTransactionId);
        console.log('Pending registration cleaned up');
        
        res.json({ success: true, status });

    } catch (error) {
        console.error('Callback processing failed', error);
        res.status(500).json({ error: 'Callback processing failed', message: error.message });
    }
});

// Add this method to your PhonePeClient class


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

app.get("/", (req, res) => {
    console.log('Root endpoint accessed');
    res.send("Welcome to the brandstories ");
});

app.post("/api/verify", (req, res) => {
    console.log('Verification endpoint accessed');
    
    // Send an HTML response with a custom UI and auto-redirect
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verification in Progress</title>
        <style>
            body {
                font-family: 'Arial', sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background-color: #f0f2f5;
                text-align: center;
            }
            .verification-container {
                background-color: white;
                border-radius: 10px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                padding: 40px;
                max-width: 500px;
                width: 90%;
            }
            .spinner {
                border: 4px solid #f3f3f3;
                border-top: 4px solid #3498db;
                border-radius: 50%;
                width: 50px;
                height: 50px;
                animation: spin 1s linear infinite;
                margin: 20px auto;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            .message {
                color: #333;
                font-size: 18px;
                margin-bottom: 20px;
            }
        </style>
    </head>
    <body>
        <div class="verification-container">
            <div class="spinner"></div>
            <div class="message">
                Verification in progress. 
                <br>You will receive an email shortly.
                <br>Redirecting to our website...
            </div>
        </div>
        <script>
            // Redirect to the specified URL after 5 seconds
            setTimeout(() => {
                window.location.href = 'https://thebrandstories.co.in';
            }, 5000);
        </script>
    </body>
    </html>
    `);
});


module.exports = app;
