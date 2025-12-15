const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");

const sesClient = new SESClient({ region: process.env.SES_REGION });
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({ region: process.env.AWS_REGION });

// Rate limiting
const submissionCache = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_SUBMISSIONS_PER_IP = 3;

const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const checkRateLimit = (ip) => {
  const now = Date.now();
  const submissions = (submissionCache.get(ip) || []).filter(
    (time) => now - time < RATE_LIMIT_WINDOW
  );

  if (submissions.length >= MAX_SUBMISSIONS_PER_IP) return false;

  submissions.push(now);
  submissionCache.set(ip, submissions);
  return true;
};

const uploadFileToS3 = async (fileData, fileName, submissionId) => {
  const buffer = Buffer.from(fileData, "base64");
  const fileExtension = fileName.split(".").pop();
  const s3Key = `resumes/${submissionId}/${Date.now()}-${fileName}`;

  const contentTypes = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.RESUME_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType:
        contentTypes[fileExtension.toLowerCase()] || "application/octet-stream",
      Metadata: {
        "original-name": fileName,
        "submission-id": submissionId,
      },
    })
  );

  return `s3://${process.env.RESUME_BUCKET}/${s3Key}`;
};

exports.submit = async (event) => {
  try {
    const ip = event.requestContext?.identity?.sourceIp || "unknown";

    if (!checkRateLimit(ip)) {
      return {
        statusCode: 429,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({
          error: "Too many requests. Please try again in a few minutes.",
        }),
      };
    }

    const body = JSON.parse(event.body);
    const {
      name,
      email,
      phone,
      company,
      service,
      message,
      timeline,
      resumeFile,
      resumeFileName,
    } = body;

    if (!name || !email || !message) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({
          error: "Missing required fields: name, email, message",
        }),
      };
    }

    if (!validateEmail(email)) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({ error: "Invalid email address" }),
      };
    }

    const submissionId = uuidv4();
    const timestamp = Date.now();

    let resumeUrl = null;
    if (resumeFile && resumeFileName) {
      try {
        resumeUrl = await uploadFileToS3(
          resumeFile,
          resumeFileName,
          submissionId
        );
      } catch (error) {
        console.error("Resume upload failed:", error);
      }
    }

    const submission = {
      id: submissionId,
      name,
      email,
      phone: phone || "",
      company: company || "",
      service: service || "General Inquiry",
      timeline: timeline || "",
      message,
      resumeUrl: resumeUrl || "",
      resumeFileName: resumeFileName || "",
      status: "new",
      ipAddress: ip,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await ddbDocClient.send(
      new PutCommand({
        TableName: process.env.DYNAMODB_TABLE,
        Item: submission,
      })
    );

    const resumeInfo = resumeUrl
      ? `<p><strong>Resume:</strong> ${resumeFileName} (Stored in S3: ${resumeUrl})</p>`
      : "";

    await sesClient.send(
      new SendEmailCommand({
        Source: process.env.FROM_EMAIL,
        Destination: { ToAddresses: [process.env.TO_EMAIL] },
        Message: {
          Subject: { Data: `New Contact Form Submission - ${service}` },
          Body: {
            Html: {
              Data: `
              <h2>New Contact Form Submission</h2>
              <p><strong>Name:</strong> ${name}</p>
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Phone:</strong> ${phone || "N/A"}</p>
              <p><strong>Company:</strong> ${company || "N/A"}</p>
              <p><strong>Service:</strong> ${service}</p>
              <p><strong>Timeline:</strong> ${timeline || "N/A"}</p>
              ${resumeInfo}
              <p><strong>Message:</strong></p>
              <p>${message}</p>
              <hr>
              <p><small>Submission ID: ${submissionId}</small></p>
              <p><small>IP: ${ip}</small></p>
              <p><small>Time: ${new Date(timestamp).toISOString()}</small></p>
            `,
            },
          },
        },
      })
    );

    await sesClient.send(
      new SendEmailCommand({
        Source: process.env.FROM_EMAIL,
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: "Thank you for contacting TheZenithVisions" },
          Body: {
            Html: {
              Data: `
              <h2>Thank you, ${name}!</h2>
              <p>We received your message and will respond within 24 hours.</p>
              <p><strong>Service:</strong> ${service}</p>
              ${timeline ? `<p><strong>Timeline:</strong> ${timeline}</p>` : ""}
              ${
                resumeFileName
                  ? `<p><strong>Resume:</strong> ${resumeFileName} (received)</p>`
                  : ""
              }
              <br>
              <p>Best regards,<br>TheZenithVisions Team</p>
              <hr>
              <p><small>Reference: ${submissionId}</small></p>
            `,
            },
          },
        },
      })
    );

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
      },
      body: JSON.stringify({
        message: "Form submitted successfully",
        submissionId,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
      },
      body: JSON.stringify({
        error: "Failed to process submission",
        details: error.message,
      }),
    };
  }
};
