const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require('uuid');

// Initialize AWS clients
const sesClient = new SESClient({ region: process.env.SES_REGION });
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

// Validation helper
const validateEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

// Main handler
exports.submit = async (event) => {
  try {
    // Parse request body
    const body = JSON.parse(event.body);
    const { name, email, phone, company, service, message } = body;

    // Validation
    if (!name || !email || !message) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
        body: JSON.stringify({
          error: 'Missing required fields: name, email, message'
        }),
      };
    }

    if (!validateEmail(email)) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
        body: JSON.stringify({
          error: 'Invalid email address'
        }),
      };
    }

    // Generate unique ID
    const submissionId = uuidv4();
    const timestamp = Date.now();

    // Prepare submission data
    const submission = {
      id: submissionId,
      name,
      email,
      phone: phone || '',
      company: company || '',
      service: service || 'General Inquiry',
      message,
      status: 'new',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Save to DynamoDB
    await ddbDocClient.send(
      new PutCommand({
        TableName: process.env.DYNAMODB_TABLE,
        Item: submission,
      })
    );

    // Send email via SES
    const emailParams = {
      Source: process.env.FROM_EMAIL,
      Destination: {
        ToAddresses: [process.env.TO_EMAIL],
      },
      Message: {
        Subject: {
          Data: `New Contact Form Submission - ${service}`,
        },
        Body: {
          Html: {
            Data: `
              <h2>New Contact Form Submission</h2>
              <p><strong>Name:</strong> ${name}</p>
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Phone:</strong> ${phone || 'N/A'}</p>
              <p><strong>Company:</strong> ${company || 'N/A'}</p>
              <p><strong>Service Interested:</strong> ${service}</p>
              <p><strong>Message:</strong></p>
              <p>${message}</p>
              <hr>
              <p><small>Submission ID: ${submissionId}</small></p>
              <p><small>Submitted at: ${new Date(timestamp).toISOString()}</small></p>
            `,
          },
        },
      },
    };

    await sesClient.send(new SendEmailCommand(emailParams));

    // Send auto-reply to customer
    const autoReplyParams = {
      Source: process.env.FROM_EMAIL,
      Destination: {
        ToAddresses: [email],
      },
      Message: {
        Subject: {
          Data: 'Thank you for contacting TheZenithVisions',
        },
        Body: {
          Html: {
            Data: `
              <h2>Thank you for your inquiry, ${name}!</h2>
              <p>We have received your message and will get back to you within 24 hours.</p>
              <p><strong>Your submission details:</strong></p>
              <p><strong>Service:</strong> ${service}</p>
              <p><strong>Message:</strong> ${message}</p>
              <br>
              <p>Best regards,<br>TheZenithVisions Team</p>
              <hr>
              <p><small>Reference ID: ${submissionId}</small></p>
            `,
          },
        },
      },
    };

    await sesClient.send(new SendEmailCommand(autoReplyParams));

    // Success response
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify({
        message: 'Form submitted successfully',
        submissionId,
      }),
    };

  } catch (error) {
    console.error('Error:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify({
        error: 'Failed to process submission',
        details: error.message,
      }),
    };
  }
};
