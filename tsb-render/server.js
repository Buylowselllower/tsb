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

// Handle user form submissions (Supports both /api/orders and /api/jobs/create)
const handleOrderSubmit = (req, res) => {
  try {
    const id = crypto.randomUUID();
    const detailsData = req.body.details ? req.body.details : req.body;
    const detailsStr = typeof detailsData === 'string' ? detailsData : JSON.stringify(detailsData);

    db.prepare('INSERT INTO orders (id, details, created_at) VALUES (?,?,?)')
      .run(id, detailsStr, Date.now());

    console.log(`[ORDER CREATED] ID: ${id}`);
    res.json({ id, success: true });
  } catch (err) {
    console.error('Database insert error:', err.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
};

app.post('/api/orders', handleOrderSubmit);
app.post('/api/jobs/create', handleOrderSubmit);

// Frontend status polling
app.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT status, address FROM orders WHERE id=?').get(req.params.id);
  res.json(o || { status: 'not_found' });
});

// Worker authentication middleware
const auth = (req, res, next) => {
  const clientKey = req.headers['x-worker-key'];
  if (!WORKER_KEY || clientKey !== WORKER_KEY) {
    return res.status(401).json({ error: 'Unauthorized worker key' });
  }
  next();
};

// Bot claims next job
app.post('/api/worker/claim', auth, (req, res) => {
  const o = db.prepare(`SELECT * FROM orders WHERE status='pending' ORDER BY created_at LIMIT 1`).get();
  if (!o) return res.json(null);

  db.prepare(`UPDATE orders SET status='processing', claimed_at=? WHERE id=?`).run(Date.now(), o.id);
  console.log(`[WORKER CLAIMED] Order ID: ${o.id}`);
  res.json(o);
});

// Bot completes job
app.post('/api/worker/complete', auth, (req, res) => {
  const { id, address, error } = req.body;
  if (error) {
    db.prepare(`UPDATE orders SET status='failed' WHERE id=?`).run(id);
  } else {
    db.prepare(`UPDATE orders SET status='ready', address=? WHERE id=?`).run(address || 'COMPLETED', id);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
