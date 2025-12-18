const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Security: Input validation and sanitization
const sanitizeInput = (input) => {
  if (typeof input === "string") {
    // Remove any potential HTML/script tags
    return input.replace(/<[^>]*>/g, "").trim();
  }
  return input;
};

const validateProject = (project) => {
  const errors = [];

  if (!project.category || typeof project.category !== "string") {
    errors.push("Category is required and must be a string");
  }

  if (
    !project.title ||
    typeof project.title !== "string" ||
    project.title.length < 3
  ) {
    errors.push("Title is required and must be at least 3 characters");
  }

  if (!project.description || typeof project.description !== "string") {
    errors.push("Description is required");
  }

  if (!project.imageUrl || typeof project.imageUrl !== "string") {
    errors.push("Image URL is required");
  }

  // Validate imageUrl is from Cloudinary
  if (
    project.imageUrl &&
    !project.imageUrl.startsWith("https://res.cloudinary.com/")
  ) {
    errors.push("Image URL must be from Cloudinary");
  }

  if (project.tags && !Array.isArray(project.tags)) {
    errors.push("Tags must be an array");
  }

  return errors;
};

const validateApiKey = (event) => {
  const apiKey = event.headers["x-api-key"] || event.headers["X-API-Key"];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!apiKey || apiKey !== adminKey) {
    return false;
  }
  return true;
};

// GET /projects - Public endpoint to fetch projects
// Query params: ?category=Architecture (optional)
module.exports.getProjects = async (event) => {
  console.log("GET /projects - Event:", JSON.stringify(event));

  try {
    const category = event.queryStringParameters?.category;
    const status = event.queryStringParameters?.status || "published";

    // Security: Sanitize inputs
    const sanitizedCategory = category ? sanitizeInput(category) : null;
    const sanitizedStatus = sanitizeInput(status);

    let result;

    if (sanitizedCategory) {
      console.log(`Fetching projects for category: ${sanitizedCategory}`);

      // Query by category using GSI (Global Secondary Index)
      result = await client.send(
        new QueryCommand({
          TableName: process.env.PROJECTS_TABLE,
          IndexName: "CategoryIndex",
          KeyConditionExpression: "category = :category",
          FilterExpression: "#status = :status",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":category": sanitizedCategory,
            ":status": sanitizedStatus,
          },
        })
      );
    } else {
      console.log("Fetching all published projects");

      // Scan all projects (filtered by status)
      result = await client.send(
        new ScanCommand({
          TableName: process.env.PROJECTS_TABLE,
          FilterExpression: "#status = :status",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":status": sanitizedStatus,
          },
        })
      );
    }

    // Sort by order
    const sortedProjects = (result.Items || []).sort(
      (a, b) => a.order - b.order
    );

    console.log(`Found ${sortedProjects.length} projects`);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300", // Cache for 5 minutes
      },
      body: JSON.stringify({
        success: true,
        count: sortedProjects.length,
        category: sanitizedCategory || "all",
        projects: sortedProjects,
      }),
    };
  } catch (error) {
    console.error("Error fetching projects:", error);

    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: false,
        message: "Failed to fetch projects",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      }),
    };
  }
};
