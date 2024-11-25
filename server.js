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

// Email Configuration
const transporter = nodemailer.createTransport({
    host: 'smtp.zoho.in',
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD
    }
});

// PhonePe Payment Gateway
class PhonePeClient {
    constructor() {
        this.merchantId = process.env.PHONEPE_MID;
        this.saltKey = process.env.PHONEPE_SALTKEY;
        this.saltIndex = 1;
        this.apiUrl = process.env.PHONEPE_API_URL;
        console.log('PhonePe Client initialized');
    }

    generateChecksum(payload, apiEndpoint) {
        console.log('Generating checksum for payment');
        const string = `${Buffer.from(JSON.stringify(payload)).toString('base64')}${apiEndpoint}${this.saltKey}`;
        return `${crypto.createHash('sha256').update(string).digest('hex')}###${this.saltIndex}`;
    }

    async initiatePayment(paymentData) {
        console.log('Initiating PhonePe payment', paymentData);
        const payload = {
            merchantId: this.merchantId,
            merchantTransactionId: paymentData.orderId,
            merchantUserId: paymentData.email,
            amount: Math.round(paymentData.amount * 100),
            redirectUrl: `${process.env.BACKEND_URL}/api/verify`,
            redirectMode: "POST",
            callbackUrl: `${process.env.BACKEND_URL}/api/payment-callback`,
            mobileNumber: paymentData.phone,
            paymentInstrument: {
                type: "PAY_PAGE"
            }
        };

        const checksum = this.generateChecksum(payload, "/pg/v1/pay");
        
        const response = await fetch(`${this.apiUrl}/pay`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'X-VERIFY': checksum
            },
            body: JSON.stringify({
                request: Buffer.from(JSON.stringify(payload)).toString('base64')
            })
        });

        const data = await response.json();
        if (!data.success) {
            console.error('Payment initialization failed', data);
            throw new Error('Payment initialization failed');
        }
        console.log('Payment initiated successfully', data);
        return data;
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

// Initialize Payment
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, amount, address, packageType } = req.body;
        console.log('Registration request received', { name, email, phone, packageType });
        
        const orderId = `ORDER_${Date.now()}`;
        const ticketNumber = `TICKET_${Date.now()}`;

        // Store registration data
        global.pendingRegistrations = global.pendingRegistrations || new Map();
        global.pendingRegistrations.set(orderId, {
            name, email, phone, address, 
            package: packageType,
            ticketNumber,
            amount,
            timestamp: new Date().toISOString()
        });

        console.log('Pending registration created', { orderId, ticketNumber });

        // Initialize payment
        const phonePe = new PhonePeClient();
        const paymentData = { orderId, email, amount, phone };
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
        console.log("reached payment-callback")
        const { merchantTransactionId, status } = req.body;
        console.log('Payment callback received', { merchantTransactionId, status });

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
    res.send("You will get a Email shortly. Please hold on ................ ");
});

module.exports = app;