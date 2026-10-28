import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const db = new Database('orders.db');
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, details TEXT, status TEXT DEFAULT 'pending',
  address TEXT, created_at INTEGER, claimed_at INTEGER)`);

const WORKER_KEY = process.env.WORKER_KEY || 'my_secret_worker_key';

// 1. User submits details from Website A
app.post('/api/orders', (req, res) => {
  const id = crypto.randomUUID();
  const detailsStr = typeof req.body.details === 'string' 
    ? req.body.details 
    : JSON.stringify(req.body.details || req.body);

  db.prepare('INSERT INTO orders (id, details, created_at) VALUES (?,?,?)')
    .run(id, detailsStr, Date.now());
  res.json({ id });
});

// 2. Frontend polls status
app.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT status, address FROM orders WHERE id=?').get(req.params.id);
  res.json(o || { status: 'not_found' });
});

// Worker auth middleware
const auth = (req, res, next) => {
  const clientKey = req.headers['x-worker-key'];
  if (!WORKER_KEY || clientKey !== WORKER_KEY) {
    return res.status(401).json({ error: 'Unauthorized worker key' });
  }
  next();
};

// 3. Worker claims next job
app.post('/api/worker/claim', auth, (req, res) => {
  const o = db.prepare(`SELECT * FROM orders WHERE status='pending' ORDER BY created_at LIMIT 1`).get();
  if (!o) return res.json(null);
  db.prepare(`UPDATE orders SET status='processing', claimed_at=? WHERE id=?`).run(Date.now(), o.id);
  res.json(o);
});

// 4. Worker submits result
app.post('/api/worker/complete', auth, (req, res) => {
  const { id, address, error } = req.body;
  if (error) {
    db.prepare(`UPDATE orders SET status='failed' WHERE id=?`).run(id);
  } else {
    db.prepare(`UPDATE orders SET status='ready', address=? WHERE id=?`).run(address || 'COMPLETED', id);
  }
  res.sendStatus(200);
});

// Listen on Render's dynamic PORT or fallback to 3000 locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});