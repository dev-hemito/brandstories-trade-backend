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
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
        key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    return doc.sheetsByIndex[0];
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
    }

    generateChecksum(payload, apiEndpoint) {
        const string = `${Buffer.from(JSON.stringify(payload)).toString('base64')}${apiEndpoint}${this.saltKey}`;
        return `${crypto.createHash('sha256').update(string).digest('hex')}###${this.saltIndex}`;
    }

    async initiatePayment(paymentData) {
        const payload = {
            merchantId: this.merchantId,
            merchantTransactionId: paymentData.orderId,
            merchantUserId: paymentData.email,
            amount: Math.round(paymentData.amount * 100),
            redirectUrl: `${process.env.FRONTEND_URL}`,
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
        if (!data.success) throw new Error('Payment initialization failed');
        return data;
    }
}

// Check Registration Endpoint
app.post('/api/check-registration', async (req, res) => {
    try {
        const { email, phone } = req.body;
        const sheet = await getSheet();
        const rows = await sheet.getRows();
        
        const existingUser = rows.find(row => 
            row.get('email') === email || row.get('phone') === phone
        );

        if (existingUser) {
            return res.status(400).json({
                error: 'Already registered',
                message: 'This email or phone number is already registered'
            });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Server error', message: error.message });
    }
});

// Initialize Payment
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, amount, address, packageType } = req.body;
        
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

        // Initialize payment
        const phonePe = new PhonePeClient();
        const paymentData = { orderId, email, amount, phone };
        const paymentResponse = await phonePe.initiatePayment(paymentData);

        res.json({
            success: true,
            paymentUrl: paymentResponse.data.instrumentResponse.redirectInfo.url,
            orderId,
            ticketNumber
        });

    } catch (error) {
        res.status(500).json({ error: 'Registration failed', message: error.message });
    }
});

// Payment Callback
app.post('/api/payment-callback', async (req, res) => {
    try {
        const { merchantTransactionId, status } = req.body;
        const registrationData = global.pendingRegistrations.get(merchantTransactionId);

        if (!registrationData) {
            return res.status(404).json({ error: 'Registration data not found' });
        }

        if (status === 'success') {
            // Add to sheet
            const sheet = await getSheet();
            await sheet.addRow({
                ...registrationData,
                paymentStatus: 'Success',
                orderId: merchantTransactionId
            });

            // Send success email
            await transporter.sendMail({
                from: process.env.SMTP_EMAIL,
                to: registrationData.email,
                subject: 'Registration Successful - Trading Summit',
                html: `
                    <h1>Registration Successful!</h1>
                    <p>Dear ${registrationData.name},</p>
                    <p>Your registration is confirmed.</p>
                    <p>Ticket Number: ${registrationData.ticketNumber}</p>
                    <p>Package: ${registrationData.package}</p>
                `
            });
        } else {
            // Send failure email
            await transporter.sendMail({
                from: process.env.SMTP_EMAIL,
                to: registrationData.email,
                subject: 'Registration Failed - Trading Summit',
                html: `
                    <h1>Registration Failed</h1>
                    <p>Dear ${registrationData.name},</p>
                    <p>Your registration payment was unsuccessful.</p>
                    <p>Please try again or contact support.</p>
                `
            });
        }

        global.pendingRegistrations.delete(merchantTransactionId);
        res.json({ success: true, status });

    } catch (error) {
        res.status(500).json({ error: 'Callback processing failed', message: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});


module.exports = app