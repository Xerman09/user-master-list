// server_users.js

// --- 1. Import Dependencies ---
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

// --- 2. Initialize the Express App ---
const app = express();
const PORT = 3002;

// --- 3. Configuration ---
const EXTERNAL_API_BASE = 'http://goatedcodoer:8080/api';
const SESSIONS = new Map();
const SESSION_COOKIE = 'vos_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const DEBUG = process.env.DEBUG_VOS === '1';

// --- 4. Middleware ---
const ALLOWED_ORIGINS = [
    'http://localhost:3002',
    'http://localhost:63342',
    'http://192.168.100.160:3002',
    'http://192.168.100.160',
    'http://127.0.0.1:63342',
    'http://100.119.3.44:3002',
    'http://100.119.3.44'
];
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        try {
            const allowTailscaleHost = /\.tailscale\.net(?::\d+)?$/i.test(new URL(origin).host);
            const allowTailnetIp = /^https?:\/\/100\./i.test(origin);
            if (allowTailscaleHost || allowTailnetIp) {
                return callback(null, true);
            }
        } catch (_) {}
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// Serve static frontend
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// --- Helpers ---
function parseCookies(req) {
    const header = req.headers['cookie'];
    const out = {};
    if (!header) return out;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > -1) {
            const k = pair.slice(0, idx).trim();
            const v = decodeURIComponent(pair.slice(idx + 1).trim());
            out[k] = v;
        }
    });
    return out;
}

function setSessionCookie(res, token) {
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: SESSION_TTL_MS
    });
}

function getSessionUser(req) {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const entry = SESSIONS.get(token);
    if (!entry) return null;
    const { user, expiresAt } = entry;
    if (Date.now() > expiresAt) {
        SESSIONS.delete(token);
        return null;
    }
    return user;
}

// --- 5. API Routes ---

// Department mapping helpers
async function fetchDepartmentsMap() {
    try {
        const { data } = await axios.get(`${EXTERNAL_API_BASE}/departments`, { timeout: 10000 });
        let list = [];
        if (Array.isArray(data)) list = data;
        else if (data && Array.isArray(data.data)) list = data.data;
        else if (data && Array.isArray(data.content)) list = data.content;
        else if (data && data.data && Array.isArray(data.data.content)) list = data.data.content;
        else if (data && Array.isArray(data.departments)) list = data.departments;
        const byId = new Map();
        const byName = new Map();
        for (const item of list) {
            const idRaw = (item?.departmentId ?? item?.id ?? item?.department_id ?? item?.dept_id);
            const name = (item?.departmentName ?? item?.name ?? item?.department_name ?? item?.dept_name ?? '');
            const n = parseInt(idRaw, 10);
            const id = Number.isNaN(n) ? null : n;
            if (id != null) byId.set(id, name);
            if (name) byName.set(String(name).trim().toLowerCase(), id);
        }
        return { byId, byName };
    } catch (_) {
        return { byId: new Map(), byName: new Map() };
    }
}
function parseIntOrNull(v) {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
}
function normalizeDepartmentFields(u, deptMaps = null) {
    const out = { ...u };
    let depId = parseIntOrNull(out.departmentId ?? out.department_id ?? out.dept_id ?? out.user_department ?? out.userDepartment);
    if (depId == null) {
        const dep = out.department;
        const idFromDepartmentKey = parseIntOrNull(dep);
        if (idFromDepartmentKey != null) depId = idFromDepartmentKey;
        if (depId == null && dep && typeof dep === 'object') {
            const nestedId = parseIntOrNull(dep.id ?? dep.departmentId ?? dep.department_id ?? dep.dept_id);
            if (nestedId != null) depId = nestedId;
        }
    }
    let depName = out.departmentName ?? out.department_name ?? out.dept_name;
    if (!depName) {
        const dep = out.department;
        if (dep && typeof dep === 'string' && Number.isNaN(parseInt(dep, 10))) depName = dep;
        if (dep && typeof dep === 'object') {
            depName = dep.name ?? dep.departmentName ?? dep.department_name ?? dep.dept_name ?? depName;
        }
    }
    if ((!depName || depName === '') && depId != null && deptMaps && deptMaps.byId.has(depId)) {
        depName = deptMaps.byId.get(depId);
    } else if (depName && depId == null && deptMaps) {
        const lookup = deptMaps.byName.get(String(depName).trim().toLowerCase());
        if (lookup != null) depId = lookup;
    }
    if (depId != null) out.departmentId = depId;
    if (depName != null) out.departmentName = depName;
    return out;
}

// Serve address JSON files
const serveAddressFile = (fileName, res) => {
    const filePath = path.join(__dirname, '..', 'data', fileName);
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading ${fileName}:`, err);
            return res.status(500).json({ message: `Could not load ${fileName}.` });
        }
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
    });
};
app.get('/api/provinces', (req, res) => serveAddressFile('province.json', res));
app.get('/api/cities', (req, res) => serveAddressFile('city.json', res));
app.get('/api/barangays', (req, res) => serveAddressFile('barangay.json', res));

/**
 * @route   GET /api/users
 * @desc    Proxy to fetch all users from external API and normalize department fields.
 */
app.get('/api/users', async (req, res) => {
    try {
        const [usersResp, deptMaps] = await Promise.all([
            axios.get(`${EXTERNAL_API_BASE}/users`, { timeout: 10000 }),
            fetchDepartmentsMap()
        ]);
        const data = usersResp.data;
        const normalizeList = (arr) => Array.isArray(arr) ? arr.map(u => normalizeDepartmentFields(u, deptMaps)) : [];
        let out = data;
        if (Array.isArray(data)) out = normalizeList(data);
        else if (data && Array.isArray(data.data)) out = { ...data, data: normalizeList(data.data) };
        else if (data && Array.isArray(data.content)) out = { ...data, content: normalizeList(data.content) };
        res.json(out);
    } catch (err) {
        console.error('GET /api/users proxy error:', err.message);
        res.status(500).json({ message: 'Failed to fetch users: The external API is not responding.' });
    }
});

// Auth
app.post('/api/login', async (req, res) => {
    try {
        const body = req.body || {};
        const email = body.email || body.username || body.user_email;
        const password = body.password || body.user_password;
        if (!email || !password) {
            return res.status(400).json({ ok: false, message: 'Email/username and password are required.' });
        }
        const { data: users } = await axios.get(`${EXTERNAL_API_BASE}/users`, { timeout: 10000 });
        const list = Array.isArray(users) ? users : [];
        const user = list.find(u => u.email === email);
        if (!user || String(password) !== String(user.password)) {
            return res.status(401).json({ ok: false, message: 'Invalid credentials.' });
        }
        const token = crypto.randomBytes(24).toString('hex');
        SESSIONS.set(token, {
            user: { id: user.id, email: user.email, name: user.name || user.fullName || user.email },
            expiresAt: Date.now() + SESSION_TTL_MS
        });
        setSessionCookie(res, token);
        return res.json({
            ok: true,
            message: 'Login successful',
            user: { id: user.id, email: user.email, name: user.name || user.fullName || user.email }
        });
    } catch (err) {
        console.error('Login error:', err.message);
        return res.status(500).json({ ok: false, message: 'Could not connect to the authentication service.' });
    }
});

app.get('/api/auth/current-login', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ ok: false, message: 'Not authenticated' });
    return res.json({ ok: true, user });
});

app.post('/api/logout', (req, res) => {
    try {
        const cookies = parseCookies(req);
        const token = cookies[SESSION_COOKIE];
        if (token) {
            SESSIONS.delete(token);
        }
        res.cookie(SESSION_COOKIE, '', {
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
            path: '/',
            maxAge: 0
        });
        return res.json({ ok: true, message: 'Logged out' });
    } catch (e) {
        console.error('Logout error:', e?.message || e);
        return res.status(500).json({ ok: false, message: 'Failed to logout' });
    }
});

// Helper: clean/sanitize payload before forwarding to external API
function sanitizeUserPayload(input) {
    const payload = { ...input };

    // Drop fields we never forward
    const dropKeys = ['token', 'userId', 'externalId'];
    for (const k of dropKeys) {
        if (k in payload) delete payload[k];
    }

    // Trim strings
    for (const [k, v] of Object.entries(payload)) {
        if (typeof v === 'string') payload[k] = v.trim();
    }

    // Normalize departmentId to number if possible (keep if not parseable)
    if (payload.departmentId != null) {
        const n = parseInt(payload.departmentId, 10);
        if (!Number.isNaN(n)) payload.departmentId = n;
    }

    // Convert empty strings for optional identifiers to null
    const toNullIfEmpty = (s) => (s === '' ? null : s);
    payload.rfId = toNullIfEmpty(payload.rfId);
    payload.tin = toNullIfEmpty(payload.tin);
    payload.sss = toNullIfEmpty(payload.sss);
    payload.philhealth = toNullIfEmpty(payload.philhealth);
    payload.image = toNullIfEmpty(payload.image);
    payload.branchName = toNullIfEmpty(payload.branchName);
    payload.departmentName = toNullIfEmpty(payload.departmentName);

    // Provide common alias keys expected by some external APIs
    if (payload.departmentId != null) {
        if (payload.department_id == null) payload.department_id = payload.departmentId;
        if (payload.dept_id == null) payload.dept_id = payload.departmentId;
        // legacy/loose keys that sometimes accept a number:
        if (payload.department == null) payload.department = payload.departmentId;
        if (payload.user_department == null) payload.user_department = payload.departmentId;
        if (payload.userDepartment == null) payload.userDepartment = payload.departmentId;

        // IMPORTANT: also provide nested relation shapes for JPA-backed APIs
        payload.departmentObj = { id: payload.departmentId, departmentId: payload.departmentId }; // internal helper
        // Put the nested shapes under names commonly mapped by DTOs / Entities
        payload.department = payload.departmentObj;       // override primitive with object (some APIs require this)
        payload.userDepartment = { id: payload.departmentId, departmentId: payload.departmentId };
    }

    if (payload.rfId != null && payload.rfid == null) payload.rfid = payload.rfId;
    if (payload.tin != null) {
        if (payload.tinNumber == null) payload.tinNumber = payload.tin;
        if (payload.tin_no == null) payload.tin_no = payload.tin;
        if (payload.tinId == null) payload.tinId = payload.tin;
        if (payload.user_tin == null) payload.user_tin = payload.tin;
        if (payload.userTin == null) payload.userTin = payload.tin;
    }
    if (payload.sss != null) {
        if (payload.sssNumber == null) payload.sssNumber = payload.sss;
        if (payload.sss_no == null) payload.sss_no = payload.sss;
        if (payload.user_sss == null) payload.user_sss = payload.sss;
        if (payload.userSss == null) payload.userSss = payload.sss;
    }
    if (payload.philhealth != null) {
        if (payload.philHealth == null) payload.philHealth = payload.philhealth;
        if (payload.philhealthNumber == null) payload.philhealthNumber = payload.philhealth;
        if (payload.philHealthNumber == null) payload.philHealthNumber = payload.philhealth;
        if (payload.philhealth_no == null) payload.philhealth_no = payload.philhealth;
        if (payload.user_philhealth == null) payload.user_philhealth = payload.philhealth;
        if (payload.userPhilhealth == null) payload.userPhilhealth = payload.philhealth;
    }

    // Dates -> yyyy-mm-dd when possible
    const toYMD = (val) => {
        if (val == null) return val;
        const s = String(val).trim();
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const d = new Date(s);
        if (isNaN(d.getTime())) return s;
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    };
    if ('birthday' in payload) payload.birthday = toYMD(payload.birthday);
    if ('dateOfHire' in payload) payload.dateOfHire = toYMD(payload.dateOfHire);

    // map common alt keys
    if (payload.mobileNumber == null && payload.userContact != null) payload.mobileNumber = payload.userContact;

    return payload;
}

// Helper used by create: if external API ignored department, try to set it via update-like endpoints
async function bestEffortSetDepartmentAfterCreate(created, depId, depName) {
    if (!created || !depId) return created;
    const userId = created.userId || created.id;
    if (!userId) return created;

    const body = sanitizeUserPayload({
        userId,
        departmentId: depId,
        departmentName: depName || undefined
    });

    const attempts = [
        { method: 'put',   url: `${EXTERNAL_API_BASE}/users/${userId}`, body },
        { method: 'patch', url: `${EXTERNAL_API_BASE}/users/${userId}`, body },
        { method: 'post',  url: `${EXTERNAL_API_BASE}/users`,           body: { ...body, userId } },
        { method: 'post',  url: `${EXTERNAL_API_BASE}/users/update`,    body: { ...body, userId } }
    ];

    for (const a of attempts) {
        try {
            if (DEBUG) console.log('[DEBUG] Follow-up set department =>', a.method.toUpperCase(), a.url, JSON.stringify(a.body));
            const { data } = await axios[a.method](a.url, a.body, { timeout: 10000 });
            return data || created;
        } catch (e) {
            // keep trying alternatives
        }
    }
    return created;
}

// Create user
app.post('/api/users', async (req, res) => {
    try {
        // 1) Load departments map (id<->name)
        const deptMaps = await fetchDepartmentsMap();

        // 2) Build and sanitize payload, default to active unless explicitly false
        let payload = sanitizeUserPayload({ ...req.body, isActive: req.body?.isActive ?? true });

        // 3) Resolve department from whatever the client sent
        const tryParseInt = (v) => {
            const n = parseInt(v, 10);
            return Number.isNaN(n) ? null : n;
        };

        let depId =
            tryParseInt(payload.departmentId ?? payload.department_id ?? payload.dept_id ?? payload.user_department ?? payload.userDepartment);

        if (depId == null && payload.department != null) {
            // could be id or name or nested object
            if (typeof payload.department === 'object') {
                depId = tryParseInt(payload.department.id ?? payload.department.departmentId ?? payload.department.department_id ?? payload.department.dept_id);
            } else {
                depId = tryParseInt(payload.department);
            }
        }

        let depName = (
            payload.departmentName ??
            payload.department_name ??
            payload.dept_name ??
            (typeof payload.department === 'string' && Number.isNaN(parseInt(payload.department, 10)) ? payload.department : null)
        )?.toString()?.trim() || null;

        if (depId == null && depName) {
            const lookup = deptMaps.byName.get(depName.toLowerCase());
            if (lookup != null) depId = lookup;
        }
        if (depName == null && depId != null && deptMaps.byId.has(depId)) {
            depName = deptMaps.byId.get(depId);
        }

        // 3b) Stamp payload with every shape the external API might accept (including nested objects)
        if (depId != null) {
            payload.departmentId = depId;
            payload.department_id = depId;
            payload.dept_id = depId;
            payload.user_department = depId;
            payload.userDepartment = depId;

            // nested relation candidates
            payload.department = { id: depId, departmentId: depId };
            payload.userDepartment = { id: depId, departmentId: depId };
        }
        if (depName != null) {
            payload.departmentName = depName;
            payload.department_name = depName;
            payload.dept_name = depName;
            // also include name inside nested object (some DTOs read it)
            if (payload.department && typeof payload.department === 'object') {
                payload.department.name = depName;
                payload.department.departmentName = depName;
            }
            if (payload.userDepartment && typeof payload.userDepartment === 'object') {
                payload.userDepartment.name = depName;
                payload.userDepartment.departmentName = depName;
            }
        }

        if (DEBUG) console.log('[DEBUG] Create payload =>', JSON.stringify(payload));

        // 4) Send to external API
        const { data } = await axios.post(`${EXTERNAL_API_BASE}/users`, payload, { timeout: 10000 });

        // 5) If department still missing, try a follow-up update to force department
        let possiblyUpdated = data;
        if (
            (data?.departmentId == null && data?.user_department == null && (!data?.department || data?.department?.id == null)) &&
            depId != null
        ) {
            possiblyUpdated = await bestEffortSetDepartmentAfterCreate(data, depId, depName || undefined);
        }

        // 6) Normalize response
        let out = possiblyUpdated;
        if (out && typeof out === 'object') {
            out = normalizeDepartmentFields({
                ...out,
                departmentId: out.departmentId ?? payload.departmentId ?? payload.department_id ?? payload.dept_id ?? payload.user_department ?? payload.userDepartment,
                departmentName: out.departmentName ?? payload.departmentName ?? payload.department_name ?? payload.dept_name
            }, deptMaps);
        }

        res.status(201).json(out);
    } catch (err) {
        console.error('POST /api/users proxy error:', err?.response?.data || err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to create user via the external API.';
        res.status(status).json({ message });
    }
});

// Update user (DO NOT create a new one)
app.put('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deptMaps = await fetchDepartmentsMap();

        // Pre-normalize on the way out
        let sanitized = sanitizeUserPayload(req.body || {});
        sanitized = normalizeDepartmentFields(sanitized, deptMaps);

        // If we have a departmentId, add nested objects for relation-backed APIs
        if (sanitized.departmentId != null) {
            const depId = sanitized.departmentId;
            const depName = sanitized.departmentName || (deptMaps.byId.get(depId) || null);
            sanitized.department = { id: depId, departmentId: depId };
            sanitized.userDepartment = { id: depId, departmentId: depId };
            if (depName) {
                sanitized.department.name = depName;
                sanitized.department.departmentName = depName;
                sanitized.userDepartment.name = depName;
                sanitized.userDepartment.departmentName = depName;
            }
        }

        if (DEBUG) console.log('[DEBUG] Update payload =>', JSON.stringify(sanitized));

        const withUserId = { ...sanitized, userId: Number.isNaN(parseInt(id, 10)) ? id : parseInt(id, 10) };

        const attempts = [
            { method: 'put',   url: `${EXTERNAL_API_BASE}/users/${id}`, body: sanitized },
            { method: 'patch', url: `${EXTERNAL_API_BASE}/users/${id}`, body: sanitized },
            { method: 'post',  url: `${EXTERNAL_API_BASE}/users`,        body: withUserId },
            { method: 'post',  url: `${EXTERNAL_API_BASE}/users/update`, body: withUserId }
        ];

        let lastErr = null;
        for (const a of attempts) {
            try {
                console.log(`Proxy update attempt => ${a.method.toUpperCase()} ${a.url}`);
                const { data } = await axios[a.method](a.url, a.body, { timeout: 10000 });
                const out = normalizeDepartmentFields(
                    {
                        ...(data && typeof data === 'object' ? data : {}),
                        departmentId: data?.departmentId ?? sanitized.departmentId,
                        departmentName: data?.departmentName ?? sanitized.departmentName
                    },
                    deptMaps
                );
                return res.json(out);
            } catch (e) {
                lastErr = e;
                const status = e.response?.status;
                const msg = e.response?.data?.message || e.message || '';
                console.warn(`Update attempt failed (${a.method.toUpperCase()} ${a.url}) => status ${status || 'n/a'} message: ${msg}`);
                if (status && [401, 403, 422].includes(status)) break;
            }
        }

        const status = lastErr?.response?.status || 500;
        const message = lastErr?.response?.data?.message || lastErr?.message || 'Failed to update user via the external API.';
        return res.status(status).json({ message });
    } catch (err) {
        console.error('PUT /api/users/:id proxy error (wrapper):', err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to update user via the external API.';
        return res.status(status).json({ message });
    }
});

// Departments proxy
app.get('/api/departments', async (req, res) => {
    try {
        const { data } = await axios.get(`${EXTERNAL_API_BASE}/departments`, { timeout: 10000 });
        let list = [];
        if (Array.isArray(data)) list = data;
        else if (data && Array.isArray(data.data)) list = data.data;
        else if (data && Array.isArray(data.content)) list = data.content;
        else if (data && data.data && Array.isArray(data.data.content)) list = data.data.content;
        else if (data && Array.isArray(data.departments)) list = data.departments;

        const normalized = list.map(item => ({
            departmentId: item.departmentId ?? item.id ?? item.department_id ?? item.dept_id ?? null,
            departmentName: item.departmentName ?? item.name ?? item.department_name ?? item.dept_name ?? ''
        }));
        res.json(normalized);
    } catch (err) {
        console.error('GET /api/departments proxy error:', err.message);
        res.status(500).json({ message: 'Failed to fetch departments from the external API.' });
    }
});

// --- 6. Start the Server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log('--------------------------------------');
    console.log(`🚀 Advanced Server is running!`);
    console.log(`✅ Front-end served at: http://localhost:${PORT}`);
    console.log(`✅ Also reachable via Tailscale (if on your tailnet): http://100.119.3.44:${PORT}`);
    console.log(`✅ API requests are being proxied to: ${EXTERNAL_API_BASE}`);
    console.log('--------------------------------------');
});
