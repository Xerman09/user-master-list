// backend/server_users.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const app = express();

/* ===== CONFIG ===== */
const HOST = '0.0.0.0';
const PORT = 3002;
const DIRECTUS = 'http://100.110.197.61:8091/items';
const BASE_FILE_HOST = process.env.BASE_FILE_HOST || '';

const DIRECTUS_TOKEN = (() => {
    const p = path.join(__dirname, 'directus.token');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();

    console.warn('⚠️ directus.token not found (optional).');
    return '';
})();

const api = axios.create({
    baseURL: DIRECTUS,
    timeout: 15000,
    headers: { ...(DIRECTUS_TOKEN ? { Authorization: `Bearer ${DIRECTUS_TOKEN}` } : {}) },
});

/* ===== MIDDLEWARE ===== */
app.use(cors({ origin: (_o, cb) => cb(null, true), credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use((req, _res, next) => {
    console.log(new Date().toISOString(), req.method, req.url);
    next();
});

/* ===== STATIC ===== */
const FRONTEND_DIR = path.join(__dirname, '../frontend');
const DATA_DIR = path.join(__dirname, '../data');
const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.static(FRONTEND_DIR));
app.use('/data', express.static(DATA_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

/* ===== MULTER ===== */
function mkStorage(subdir) {
    return multer.diskStorage({
        destination: (_req, _file, cb) => {
            const d = path.join(UPLOADS_DIR, subdir);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            cb(null, d);
        },
        filename: (_req, file, cb) => {
            const ts = Date.now();
            const safe = (file.originalname || 'file')
                .replace(/[^a-z0-9.\-_]/gi, '_')
                .toLowerCase();
            cb(null, `${ts}_${safe}`);
        },
    });
}
const uploadUser = multer({ storage: mkStorage('users') });
const uploadSignature = multer({ storage: mkStorage('signatures') });

/* ===== HELPERS ===== */
function rewriteLegacyPath(val) {
    if (!val) return val;
    if (/^https?:\/\//i.test(val) || val.startsWith('/uploads/')) return val;
    const smbLike = val.startsWith('\\\\') || val.startsWith('//') || val.startsWith('file://');
    if (BASE_FILE_HOST && smbLike) {
        const cleaned = val
            .replace(/^file:\/\//i, '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '');
        return `${BASE_FILE_HOST}/${cleaned}`;
    }
    return null;
}

function toBoolMaybeBuffer(val) {
    if (val && typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data)) {
        return !!val.data[0];
    }
    if (typeof val === 'number') return !!val;
    return !!val;
}

/** Normalize user:
 * - Always expose `isDeleted` as boolean (FIX)
 * - Keep `is_deleted` too (for transparency), but `isDeleted` is the one frontend reads.
 */
function transformUser(u) {
    if (!u || typeof u !== 'object') return u;

    const normalizedIsDeleted = toBoolMaybeBuffer(u.isDeleted ?? u.is_deleted ?? false); // FIX

    return {
        ...u,
        user_image: rewriteLegacyPath(u.user_image),
        signature: rewriteLegacyPath(u.signature),
        is_deleted: u.is_deleted ?? undefined, // passthrough if present
        isDeleted: normalizedIsDeleted,        // FIX: guaranteed boolean
        isAdmin: toBoolMaybeBuffer(u.isAdmin),
    };
}

function transformResp(data) {
    if (Array.isArray(data?.data))
        return { ...data, data: data.data.map(transformUser) };
    if (data?.data && typeof data.data === 'object')
        return { ...data, data: transformUser(data.data) };
    return data;
}

/* ===== SANITIZE PAYLOAD ===== */
const STRING_FIELDS = new Set([
    'user_email','user_password','user_fname','user_mname','user_lname','user_contact',
    'user_province','user_city','user_brgy','user_position','user_dateOfHire','user_bday',
    'rf_id','user_tin','user_sss','user_philhealth','user_pagibig','user_image','signature',
    'emergency_contact_name','emergency_contact_number','external_id','externalId','role_id'
]);

function sanitizeUserPayload(src, isPatch = false) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    for (const [k, v] of Object.entries(src)) {
        if (STRING_FIELDS.has(k)) {
            if (isPatch) {
                if (v === undefined || v === null || String(v).trim() === '') continue;
                out[k] = String(v);
            } else {
                out[k] = v == null ? null : String(v);
            }
        } else if (k === 'user_department') {
            if (isPatch) {
                if (v === undefined || v === null || v === '') continue;
                const n = Number(v);
                if (Number.isFinite(n)) out[k] = n;
            } else {
                const n = v === '' || v == null ? null : Number(v);
                out[k] = Number.isFinite(n) ? n : null;
            }
        } else if (['isAdmin', 'isDeleted', 'is_deleted'].includes(k)) {
            if (isPatch && v === undefined) continue;
            out[k] = v ? 1 : 0; // Convert boolean to number (for Directus BIT/boolean)
        } else {
            if (isPatch && v === undefined) continue;
            out[k] = v;
        }
    }

    // FIX: if client sent isDeleted, map to is_deleted for Directus collections
    if ('isDeleted' in out && !('is_deleted' in out)) {
        out.is_deleted = out.isDeleted;
        delete out.isDeleted;
    }

    return out;
}

/* ===== AUTH ===== */
app.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });
    try {
        const params = {
            'filter[user_email][_eq]': email,
            'filter[user_password][_eq]': password,
            fields: 'user_id,user_fname,user_lname',
            limit: 1,
        };
        const { data } = await api.get('/user', { params });
        const user = (data.data || [])[0];
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const token = Buffer.from(
            JSON.stringify({ userId: user.user_id, ts: Date.now() })
        ).toString('base64');
        res.cookie('token', token, { httpOnly: true, secure: false, path: '/' });
        res.json({ userId: user.user_id, fullName: `${user.user_fname} ${user.user_lname}` });
    } catch (err) {
        res
            .status(err.response?.status || 502)
            .json({ error: 'Login failed', detail: err.response?.data || err.message });
    }
});
app.post('/logout', (_req, res) => { res.clearCookie('token'); res.sendStatus(200); });

/* ===== DEPARTMENTS ===== */
app.get('/items/department', async (_req, res) => {
    try {
        const { data } = await api.get('/department?limit=-1');
        res.json(data);
    } catch (err) {
        res
            .status(err.response?.status || 502)
            .json({ error: 'Department list failed', detail: err.response?.data || err.message });
    }
});

/* ===== USERS ===== */
/** FIX: include both is_deleted and isDeleted in requested FIELDS (some schemas differ) */
const FIELDS = [
    'user_id','user_email','user_password','user_fname','user_mname','user_lname','user_contact',
    'user_province','user_city','user_brgy','user_department',
    'user_position','user_dateOfHire','user_bday','rf_id','user_image','signature','isAdmin',
    'user_sss','user_philhealth','user_tin','user_pagibig','emergency_contact_name','emergency_contact_number',
    'external_id','externalId','role_id','biometric_id',
    'is_deleted','isDeleted',  // FIX: ensure status is fetched if present in collection
    'updateAt','update_at'
].join(',');

app.get('/items/user', async (_req, res) => {
    try {
        const { data } = await api.get('/user', { params: { fields: FIELDS, limit: -1 } });
        res.json(transformResp(data));
    } catch (err) {
        res
            .status(err.response?.status || 502)
            .json({ error: 'User list failed', detail: err.response?.data || err.message });
    }
});

app.get('/items/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data } = await api.get(`/user/${id}`, { params: { fields: FIELDS } });
        res.json(transformResp(data));
    } catch (err) {
        res
            .status(err.response?.status || 502)
            .json({ error: 'Get user failed', detail: err.response?.data || err.message });
    }
});

app.post('/items/user', async (req, res) => {
    try {
        const body = sanitizeUserPayload(req.body, false);
        const { data } = await api.post('/user', body);
        res.json(transformResp(data));
    } catch (err) {
        res
            .status(err.response?.status || 500)
            .json({ error: 'Create user failed', detail: err.response?.data || err.message });
    }
});

app.patch('/items/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const body = sanitizeUserPayload(req.body, true);
        try {
            const { data } = await api.patch(`/user/${id}`, body);
            return res.json(transformResp(data));
        } catch (e) {
            if (e.response && (e.response.status === 405 || e.response.status === 501)) {
                const existingResp = await api.get(`/user/${id}`, { params: { fields: FIELDS } });
                const existing = existingResp?.data?.data || {};
                const merged = { ...existing, ...body };
                const { data } = await api.put(`/user/${id}`, merged);
                return res.json(transformResp(data));
            }
            throw e;
        }
    } catch (err) {
        res
            .status(err.response?.status || 500)
            .json({ error: err.response?.data?.errors?.[0]?.message || 'Failed to update user' });
    }
});

/* ===== UPLOAD ENDPOINTS ===== */
app.post('/upload/user', uploadUser.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    res.json({ url: `/uploads/users/${req.file.filename}` });
});
app.post('/upload/signature', uploadSignature.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    res.json({ url: `/uploads/signatures/${req.file.filename}` });
});
app.post('/uploads/users', uploadUser.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    res.json({ url: `/uploads/users/${req.file.filename}` });
});
app.post('/uploads/signatures', uploadSignature.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');
    res.json({ url: `/uploads/signatures/${req.file.filename}` });
});

/* ===== SIGNATURE DATA URL ===== */
function saveSignatureDataUrl(req, res) {
    try {
        const { dataUrl } = req.body || {};
        if (!dataUrl || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
            return res.status(400).json({ error: 'Invalid signature data' });
        }
        const base64 = dataUrl.split(',')[1];
        const buf = Buffer.from(base64, 'base64');
        const dir = path.join(UPLOADS_DIR, 'signatures');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const name = `sig_${Date.now()}.png`;
        fs.writeFileSync(path.join(dir, name), buf);
        return res.json({ url: `/uploads/signatures/${name}` });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save signature', detail: e.message });
    }
}
app.post('/signature', saveSignatureDataUrl);
app.post('/signatures', saveSignatureDataUrl);

/* ===== DEBUG ===== */
app.get('/health', (_req, res) => res.json({ ok: true, startedAt: new Date().toISOString() }));
app.get('/__debug/routes', (_req, res) => {
    const list = app._router.stack
        .filter((r) => r.route)
        .map((r) => ({ method: Object.keys(r.route.methods)[0].toUpperCase(), path: r.route.path }));
    res.json(list);
});

/* ===== ROUTES ===== */
app.get('/', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

/* ===== START ===== */
app.listen(PORT, HOST, () => {
    console.log(`✅ Server running at http://localhost:${PORT}/`);
});
