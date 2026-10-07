/**
 * Vercel Serverless Function Entrypoint
 *
 * Responsibility:
 * Boots the Express app within Vercel Serverless Function runtime.
 * Ensures cached MongoDB connection is established before routing requests.
 */

const app = require('../src/app');
const { connectDb } = require('../src/utils/db');

module.exports = async (req, res) => {
  try {
    await connectDb();
    return app(req, res);
  } catch (error) {
    console.error('[vercel-serverless] Database connection failure:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to establish database connection.',
    });
  }
};
