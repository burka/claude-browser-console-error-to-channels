/**
 * Read an HTTP request body with a size limit.
 * Returns the parsed string, or null if aborted (413 already sent).
 */
export async function readBody(req, res, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      res.writeHead(413).end("payload too large");
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}
