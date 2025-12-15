const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });

exports.list = async (event) => {
  try {
    const result = await ddbClient.send(
      new ScanCommand({
        TableName: process.env.DYNAMODB_TABLE,
      })
    );

    const submissions = result.Items.map(item => unmarshall(item));
    
    // Sort by createdAt descending
    submissions.sort((a, b) => b.createdAt - a.createdAt);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify({
        submissions,
        count: submissions.length,
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
        error: 'Failed to retrieve submissions',
      }),
    };
  }
};
