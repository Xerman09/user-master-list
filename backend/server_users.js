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
const EXTERNAL_API_BASE = 'http://100.119.3.44:8055/items';
const SESSIONS = new Map();
const UPDATE_FORBIDDEN_TOKEN = undefined;
const SESSION_COOKIE = 'vos_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const DEBUG = process.env.DEBUG_VOS === '1';

// 🔐 Directus Access Token (create in Directus → Settings → Access Tokens)
// Prefer env var DIRECTUS_TOKEN; if missing, try reading from a local file "directus.token".
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN || (() => {
    try {
        const candidates = [
            path.join(__dirname, 'directus.token'),
            path.join(__dirname, '..', 'directus.token'),
            path.join(process.cwd(), 'directus.token'),
            path.join(__dirname, '.env.directus_token'),
        ];
        for (const file of candidates) {
            if (fs.existsSync(file)) {
                const t = fs.readFileSync(file, 'utf8').trim();
                if (t) return t;
            }
        }
    } catch (_) {}
    return '';
})();

// Axios helper that always includes the Authorization header (if token provided)
function ax(method, url, data = undefined, extra = {}) {
    return axios({
        method,
        url,
        data,
        timeout: 10000,
        headers: {
            ...(DIRECTUS_TOKEN ? { Authorization: `Bearer ${DIRECTUS_TOKEN}` } : {}),
            ...extra.headers,
        },
        ...extra,
    });
}

// --- 4. Middleware ---
const corsOptions = {
    origin: true,
    credentials: true,
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
    header.split(';').forEach((pair) => {
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
    // res.cookie exists in Express without cookie-parser for setting cookies
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: SESSION_TTL_MS,
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
        // Try singular first, then plural, then singular with limit=-1 (Directus)
        const endpoints = [
            `${EXTERNAL_API_BASE}/department`,
            `${EXTERNAL_API_BASE}/departments`,
            `${EXTERNAL_API_BASE}/department?limit=-1`,
        ];
        let data = null;
        for (const url of endpoints) {
            try {
                const r = await ax('get', url);
                data = r.data;
                if (data != null) break;
            } catch (_) {
                // try next
            }
        }
        let list = [];
        if (Array.isArray(data)) list = data;
        else if (data && Array.isArray(data.data)) list = data.data;
        else if (data && Array.isArray(data.content)) list = data.content;
        else if (data && data.data && Array.isArray(data.data.content)) list = data.data.content;
        else if (data && Array.isArray(data.departments)) list = data.departments;
        const byId = new Map();
        const byName = new Map();
        for (const item of list) {
            const idRaw = item?.departmentId ?? item?.id ?? item?.department_id ?? item?.dept_id;
            const name = item?.departmentName ?? item?.name ?? item?.department_name ?? item?.dept_name ?? '';
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
    let depId = parseIntOrNull(
        out.departmentId ?? out.department_id ?? out.dept_id ?? out.user_department ?? out.userDepartment
    );
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

// Enforce non-null departmentId and departmentName
function ensureDepartmentFieldsRequired(payload) {
    if (payload.departmentId == null || payload.departmentName == null || payload.departmentName === '') {
        const err = new Error('departmentId and departmentName must not be null or empty.');
        err.status = 400;
        throw err;
    }
}
// On update, only validate if caller is updating department fields
function ensureDepartmentFieldsIfProvided(payload) {
    const touchesDepartment =
        ('departmentId' in payload && payload.departmentId != null) ||
        ('departmentName' in payload && payload.departmentName != null && payload.departmentName !== '');
    if (!touchesDepartment) return; // partial update without department change is OK
    if (payload.departmentId == null || !payload.departmentName) {
        const err = new Error('If updating department, both departmentId and departmentName are required.');
        err.status = 400;
        throw err;
    }
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

// Redirect legacy /api/users* endpoints to absolute Directus URL http://100.119.3.44:8055/items/user...
// Using 308 Permanent Redirect to preserve method and body for non-GET requests.
app.all(/^\/api\/users(\/.*)?$/, (req, res) => {
    try {
        const newUrl = req.originalUrl.replace(/^\/api\/users/, `${EXTERNAL_API_BASE}/user`);
        return res.redirect(308, newUrl);
    } catch (_) {
        return res.status(410).json({
            message: 'The /api/users endpoints have been removed. Please use http://100.119.3.44:8055/items/user instead.',
            original: req.originalUrl
        });
    }
});

/**
 * @route   GET /api/users
 * @desc    Proxy to fetch all users from external API and normalize department fields.
 */
app.get('/items/user', async (req, res) => {
    try {
        const [usersResp, deptMaps] = await Promise.all([ax('get', `${EXTERNAL_API_BASE}/user`), fetchDepartmentsMap()]);
        const data = usersResp.data;
        const normalizeList = (arr) => (Array.isArray(arr) ? arr.map((u) => normalizeDepartmentFields(u, deptMaps)) : []);
        let out = data;
        if (Array.isArray(data)) out = normalizeList(data);
        else if (data && Array.isArray(data.data)) out = { ...data, data: normalizeList(data.data) };
        else if (data && Array.isArray(data.content)) out = { ...data, content: normalizeList(data.content) };
        res.json(out);
    } catch (err) {
        console.error('GET /items/user proxy error:', err.message);
        res.status(500).json({ message: 'Failed to fetch users: The external API is not responding.' });
    }
});

/**
 * @route   GET /api/users/:id/details
 * @desc    Proxy to fetch a single user's full details from the external API.
 */
app.get('/items/user/:id/details', async (req, res) => {
    const { id } = req.params;
    if (!id && id !== 0) {
        return res.status(400).json({ message: 'User ID is required.' });
    }

    const tryUrls = [
        `${EXTERNAL_API_BASE}/user/${encodeURIComponent(id)}`,
        `${EXTERNAL_API_BASE}/user?filter[id][_eq]=${encodeURIComponent(id)}&limit=1`,
        `${EXTERNAL_API_BASE}/user?filter[userId][_eq]=${encodeURIComponent(id)}&limit=1`,
        `${EXTERNAL_API_BASE}/user?filter[user_id][_eq]=${encodeURIComponent(id)}&limit=1`,
    ];

    for (const url of tryUrls) {
        try {
            const { data } = await ax('get', url);
            if (!data) continue;

            if (data.data && Array.isArray(data.data) && data.data.length > 0) return res.json(data.data[0]);
            if (data.data && typeof data.data === 'object' && data.data !== null) return res.json(data.data);
            if (Array.isArray(data) && data.length > 0) return res.json(data[0]);
            if (data && Array.isArray(data.content) && data.content.length > 0) return res.json(data.content[0]);
        } catch (err) {
            if (DEBUG) console.warn(`[DEBUG] Detail fetch attempt failed for ${url}:`, err.message);
        }
    }

    return res.status(404).json({ message: `User details not found for ID ${id}.` });
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
        const { data: usersResponse } = await ax('get', `${EXTERNAL_API_BASE}/user`);

        // Robustly find the user array in the response
        let list = [];
        if (usersResponse && Array.isArray(usersResponse.data)) {
            list = usersResponse.data;
        } else if (usersResponse && Array.isArray(usersResponse.content)) {
            list = usersResponse.content;
        } else if (Array.isArray(usersResponse)) {
            list = usersResponse;
        }

        const loginId = String(email).trim().toLowerCase();
        const user = list.find((u) => {
            const candidates = [u.email, u.user_email, u.username, u.user_name];
            return candidates.some((v) => v != null && String(v).trim().toLowerCase() === loginId);
        });
        const passMatches = (u) => {
            const passCandidates = [u?.password, u?.user_password, u?.pass, u?.pw];
            return passCandidates.some((v) => v != null && String(v) === String(password));
        };
        if (!user || !passMatches(user)) {
            return res.status(401).json({ ok: false, message: 'Invalid credentials.' });
        }
        const token = crypto.randomBytes(24).toString('hex');
        SESSIONS.set(token, {
            user: { id: user.id, email: user.email, name: user.name || user.fullName || user.email },
            expiresAt: Date.now() + SESSION_TTL_MS,
        });
        setSessionCookie(res, token);
        return res.json({
            ok: true,
            message: 'Login successful',
            user: { id: user.id, email: user.email, name: user.name || user.fullName || user.email },
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
            maxAge: 0,
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
        if (payload.department == null) payload.department = payload.departmentId;
        if (payload.user_department == null) payload.user_department = payload.departmentId;
        if (payload.userDepartment == null) payload.userDepartment = payload.departmentId;

        // nested relation shapes
        payload.departmentObj = { id: payload.departmentId, departmentId: payload.departmentId };
        payload.department = payload.departmentObj;
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

// Make body safer for Directus: relations as scalar ids and drop aliases
function directusSafeBody(input) {
    const b = { ...input };
    if (b && b.departmentId != null) {
        b.department = b.departmentId; // Directus relation field typically named "department"
    }
    // Drop alias/nested shapes that may not exist in Directus schema
    delete b.departmentObj;
    delete b.userDepartment;
    delete b.user_department;
    delete b.department_id;
    delete b.dept_id;
    // Keep departmentId/departmentName only if your Directus collection truly has those fields
    return b;
}

// Helper used by create: if external API ignored department, try to set it via update-like endpoints
async function bestEffortSetDepartmentAfterCreate(created, depId, depName) {
    if (!created || !depId) return created;
    const userId = created.userId || created.id;
    if (!userId) return created;

    const body = sanitizeUserPayload({
        userId,
        departmentId: depId,
        departmentName: depName || undefined,
    });

    const attempts = [
        { method: 'put', url: `${EXTERNAL_API_BASE}/user/${userId}`, body },
        { method: 'patch', url: `${EXTERNAL_API_BASE}/user/${userId}`, body },
        { method: 'post', url: `${EXTERNAL_API_BASE}/user`, body: { ...body, userId, id: userId } },
        { method: 'post', url: `${EXTERNAL_API_BASE}/user/update`, body: { ...body, userId, id: userId } },
    ];

    for (const a of attempts) {
        try {
            if (DEBUG) console.log('[DEBUG] Follow-up set department =>', a.method.toUpperCase(), a.url, JSON.stringify(a.body));
            const { data } = await ax(a.method, a.url, a.body);
            return data || created;
        } catch (e) {
            // keep trying alternatives
        }
    }
    return created;
}

// Create user
app.post('/items/user', async (req, res) => {
    try {
        const deptMaps = await fetchDepartmentsMap();
        let payload = sanitizeUserPayload({ ...req.body, isActive: req.body?.isActive ?? true });

        const tryParseInt = (v) => {
            const n = parseInt(v, 10);
            return Number.isNaN(n) ? null : n;
        };

        let depId = tryParseInt(
            payload.departmentId ?? payload.department_id ?? payload.dept_id ?? payload.user_department ?? payload.userDepartment
        );

        if (depId == null && payload.department != null) {
            if (typeof payload.department === 'object') {
                depId = tryParseInt(
                    payload.department.id ?? payload.department.departmentId ?? payload.department.department_id ?? payload.department.dept_id
                );
            } else {
                depId = tryParseInt(payload.department);
            }
        }

        let depName =
            (
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

        if (depId != null) {
            payload.departmentId = depId;
            payload.department_id = depId;
            payload.dept_id = depId;
            payload.user_department = depId;
            payload.userDepartment = depId;

            payload.department = { id: depId, departmentId: depId };
            payload.userDepartment = { id: depId, departmentId: depId };
        }
        if (depName != null) {
            payload.departmentName = depName;
            payload.department_name = depName;
            payload.dept_name = depName;
            if (payload.department && typeof payload.department === 'object') {
                payload.department.name = depName;
                payload.department.departmentName = depName;
            }
            if (payload.userDepartment && typeof payload.userDepartment === 'object') {
                payload.userDepartment.name = depName;
                payload.userDepartment.departmentName = depName;
            }
        }

        // STRICT for create
        ensureDepartmentFieldsRequired({ departmentId: payload.departmentId, departmentName: payload.departmentName });

        if (DEBUG) console.log('[DEBUG] Create payload =>', JSON.stringify(payload));

        const { data } = await ax('post', `${EXTERNAL_API_BASE}/user`, payload);

        let possiblyUpdated = data;
        if (
            (data?.departmentId == null && data?.user_department == null && (!data?.department || data?.department?.id == null)) &&
            depId != null
        ) {
            possiblyUpdated = await bestEffortSetDepartmentAfterCreate(data, depId, depName || undefined);
        }

        let out = possiblyUpdated;
        if (out && typeof out === 'object') {
            out = normalizeDepartmentFields(
                {
                    ...out,
                    departmentId:
                        out.departmentId ??
                        payload.departmentId ??
                        payload.department_id ??
                        payload.dept_id ??
                        payload.user_department ??
                        payload.userDepartment,
                    departmentName: out.departmentName ?? payload.departmentName ?? payload.department_name ?? payload.dept_name,
                },
                deptMaps
            );
        }

        res.status(201).json(out);
    } catch (err) {
        if (err.status === 400 && err.message === 'departmentId and departmentName must not be null or empty.') {
            return res.status(400).json({ message: err.message });
        }
        console.error('POST /items/user proxy error:', err?.response?.data || err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to create user via the external API.';
        res.status(status).json({ message });
    }
});

// Update user (DO NOT create a new one)
app.put('/items/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deptMaps = await fetchDepartmentsMap();

        let sanitized = sanitizeUserPayload(req.body || {});
        sanitized = normalizeDepartmentFields(sanitized, deptMaps);

        // STRICT for update: department is required
        ensureDepartmentFieldsRequired({ departmentId: sanitized.departmentId, departmentName: sanitized.departmentName });

        if (sanitized.departmentId != null) {
            const depId = sanitized.departmentId;
            const depName = sanitized.departmentName || deptMaps.byId.get(depId) || null;
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

        const idParsed = Number.isNaN(parseInt(id, 10)) ? id : parseInt(id, 10);
        const withUserId = { ...sanitized, userId: idParsed, id: idParsed };

        const attempts = [
            { method: 'patch', url: `${EXTERNAL_API_BASE}/user/${id}`, body: sanitized },
            { method: 'put', url: `${EXTERNAL_API_BASE}/user/${id}`, body: sanitized },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user`, body: withUserId },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user/update`, body: withUserId },
        ];

        let lastErr = null;
        for (const a of attempts) {
            try {
                console.log(`Proxy update attempt => ${a.method.toUpperCase()} ${a.url}`);
                const { data } = await ax(a.method, a.url, a.body);
                const out = normalizeDepartmentFields(
                    {
                        ...(data && typeof data === 'object' ? data : {}),
                        departmentId: data?.departmentId ?? sanitized.departmentId,
                        departmentName: data?.departmentName ?? sanitized.departmentName,
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
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    } catch (err) {
        if (err.status === 400 && (err.message === 'If updating department, both departmentId and departmentName are required.' || err.message === 'departmentId and departmentName must not be null or empty.')) {
            return res.status(400).json({ message: err.message });
        }
        console.error('PUT /items/user/:id proxy error (wrapper):', err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to update user via the external API.';
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    }
});

// Also support PATCH for updating a user (same logic)
app.patch('/items/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deptMaps = await fetchDepartmentsMap();

        let sanitized = sanitizeUserPayload(req.body || {});
        sanitized = normalizeDepartmentFields(sanitized, deptMaps);

        // STRICT for update: department is required
        ensureDepartmentFieldsRequired({ departmentId: sanitized.departmentId, departmentName: sanitized.departmentName });

        if (sanitized.departmentId != null) {
            const depId = sanitized.departmentId;
            const depName = sanitized.departmentName || deptMaps.byId.get(depId) || null;
            sanitized.department = { id: depId, departmentId: depId };
            sanitized.userDepartment = { id: depId, departmentId: depId };
            if (depName) {
                sanitized.department.name = depName;
                sanitized.department.departmentName = depName;
                sanitized.userDepartment.name = depName;
                sanitized.userDepartment.departmentName = depName;
            }
        }

        if (DEBUG) console.log('[DEBUG] Update payload (PATCH) =>', JSON.stringify(sanitized));

        const idParsed = Number.isNaN(parseInt(id, 10)) ? id : parseInt(id, 10);
        const withUserId = { ...sanitized, userId: idParsed, id: idParsed };

        const attempts = [
            { method: 'patch', url: `${EXTERNAL_API_BASE}/user/${id}`, body: sanitized },
            { method: 'put', url: `${EXTERNAL_API_BASE}/user/${id}`, body: sanitized },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user`, body: withUserId },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user/update`, body: withUserId },
        ];

        let lastErr = null;
        for (const a of attempts) {
            try {
                console.log(`Proxy update attempt (PATCH route) => ${a.method.toUpperCase()} ${a.url}`);
                const { data } = await ax(a.method, a.url, a.body);
                const out = normalizeDepartmentFields(
                    {
                        ...(data && typeof data === 'object' ? data : {}),
                        departmentId: data?.departmentId ?? sanitized.departmentId,
                        departmentName: data?.departmentName ?? sanitized.departmentName,
                    },
                    deptMaps
                );
                return res.json(out);
            } catch (e) {
                lastErr = e;
                const status = e.response?.status;
                const msg = e.response?.data?.message || e.message || '';
                console.warn(`Update attempt failed (PATCH route, ${a.method.toUpperCase()} ${a.url}) => status ${status || 'n/a'} message: ${msg}`);
                if (status && [401, 403, 422].includes(status)) break;
            }
        }

        const status = lastErr?.response?.status || 500;
        const message = lastErr?.response?.data?.message || lastErr?.message || 'Failed to update user via the external API.';
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    } catch (err) {
        if (err.status === 400 && (err.message === 'If updating department, both departmentId and departmentName are required.' || err.message === 'departmentId and departmentName must not be null or empty.')) {
            return res.status(400).json({ message: err.message });
        }
        console.error('PATCH /items/user/:id proxy error (wrapper):', err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to update user via the external API.';
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    }
});

// Departments proxy
app.get('/items/department', async (req, res) => {
    try {
        const endpoints = [
            `${EXTERNAL_API_BASE}/department`,
            `${EXTERNAL_API_BASE}/departments`,
            `${EXTERNAL_API_BASE}/department?limit=-1`,
        ];
        let data = null;
        let lastErr = null;
        for (const url of endpoints) {
            try {
                const r = await ax('get', url);
                data = r.data;
                if (data != null) break;
            } catch (e) {
                lastErr = e;
            }
        }

        let list = [];
        if (Array.isArray(data)) list = data;
        else if (data && Array.isArray(data.data)) list = data.data;
        else if (data && Array.isArray(data.content)) list = data.content;
        else if (data && data.data && Array.isArray(data.data.content)) list = data.data.content;
        else if (data && Array.isArray(data.departments)) list = data.departments;

        const normalized = list.map((item) => ({
            departmentId: item?.departmentId ?? item?.id ?? item?.department_id ?? item?.dept_id ?? null,
            departmentName: item?.departmentName ?? item?.name ?? item?.department_name ?? item?.dept_name ?? '',
        }));
        return res.json(normalized);
    } catch (err) {
        console.error('GET /items/department proxy error:', err?.response?.data || err.message);
        return res.json([]);
    }
});

// --- Directus-style routes (items/user) implemented without redirects ---
// List users (same logic as GET /api/users)
app.get('/items/user', async (req, res) => {
    try {
        const [usersResp, deptMaps] = await Promise.all([ax('get', `${EXTERNAL_API_BASE}/user`), fetchDepartmentsMap()]);
        const data = usersResp.data;
        const normalizeList = (arr) => (Array.isArray(arr) ? arr.map((u) => normalizeDepartmentFields(u, deptMaps)) : []);
        let out = data;
        if (Array.isArray(data)) out = normalizeList(data);
        else if (data && Array.isArray(data.data)) out = { ...data, data: normalizeList(data.data) };
        else if (data && Array.isArray(data.content)) out = { ...data, content: normalizeList(data.content) };
        res.json(out);
    } catch (err) {
        console.error('GET /items/user proxy error:', err.message);
        res.status(500).json({ message: 'Failed to fetch users: The external API is not responding.' });
    }
});

// Get single user details (same logic as GET /api/users/:id/details)
app.get('/items/user/:id/details', async (req, res) => {
    const { id } = req.params;
    if (!id && id !== 0) {
        return res.status(400).json({ message: 'User ID is required.' });
    }

    const tryUrls = [
        `${EXTERNAL_API_BASE}/user/${encodeURIComponent(id)}`,
        `${EXTERNAL_API_BASE}/user?filter[id][_eq]=${encodeURIComponent(id)}&limit=1`,
        `${EXTERNAL_API_BASE}/user?filter[userId][_eq]=${encodeURIComponent(id)}&limit=1`,
        `${EXTERNAL_API_BASE}/user?filter[user_id][_eq]=${encodeURIComponent(id)}&limit=1`,
    ];

    for (const url of tryUrls) {
        try {
            const { data } = await ax('get', url);
            if (!data) continue;

            if (data.data && Array.isArray(data.data) && data.data.length > 0) return res.json(data.data[0]);
            if (data.data && typeof data.data === 'object' && data.data !== null) return res.json(data.data);
            if (Array.isArray(data) && data.length > 0) return res.json(data[0]);
            if (data && Array.isArray(data.content) && data.content.length > 0) return res.json(data.content[0]);
        } catch (err) {
            if (DEBUG) console.warn(`[DEBUG] Detail fetch attempt failed for ${url}:`, err.message);
        }
    }

    return res.status(404).json({ message: `User details not found for ID ${id}.` });
});

// Direct GET for a single user (for clients expecting Directus-like /items/user/:id)
app.get('/items/user/:id', async (req, res) => {
    const { id } = req.params;
    if (!id && id !== 0) {
        return res.status(400).json({ message: 'User ID is required.' });
    }

    const accept = String(req.headers['accept'] || '').toLowerCase();

    const tryUrls = [
        `${EXTERNAL_API_BASE}/user/${encodeURIComponent(id)}`,
        `${EXTERNAL_API_BASE}/user?filter[id][_eq]=${encodeURIComponent(id)}&limit=1`,
        `${EXTERNAL_API_BASE}/user?filter[userId][_eq]=${encodeURIComponent(id)}&limit=1`,
        `${EXTERNAL_API_BASE}/user?filter[user_id][_eq]=${encodeURIComponent(id)}&limit=1`,
    ];

    let user = null;
    for (const url of tryUrls) {
        try {
            const { data } = await ax('get', url);
            if (!data) continue;
            if (data.data && Array.isArray(data.data) && data.data.length > 0) {
                user = data.data[0];
                break;
            }
            if (data.data && typeof data.data === 'object' && data.data !== null) {
                user = data.data;
                break;
            }
            if (Array.isArray(data) && data.length > 0) {
                user = data[0];
                break;
            }
            if (data && Array.isArray(data.content) && data.content.length > 0) {
                user = data.content[0];
                break;
            }
        } catch (err) {
            if (DEBUG) console.warn(`[DEBUG] GET /items/user/:id fetch attempt failed for ${url}:`, err.message);
            const st = err.response?.status;
            if (st && [401, 403].includes(st)) {
                continue;
            }
        }
    }

    if (accept.includes('image')) {
        const img = user?.image || user?.image_url || user?.img;
        if (img && /^https?:\/\//i.test(String(img))) {
            return res.redirect(302, String(img));
        }
        return res.status(204).end();
    }

    if (!user) {
        return res.status(404).json({ message: `User not found for ID ${id}.` });
    }

    try {
        const deptMaps = await fetchDepartmentsMap();
        const normalized = normalizeDepartmentFields(user, deptMaps);
        return res.json(normalized);
    } catch (e) {
        return res.json(user);
    }
});

// Create user (same logic as POST /api/users)
app.post('/items/user', async (req, res) => {
    try {
        const deptMaps = await fetchDepartmentsMap();
        let payload = sanitizeUserPayload({ ...req.body, isActive: req.body?.isActive ?? true });

        const tryParseInt = (v) => {
            const n = parseInt(v, 10);
            return Number.isNaN(n) ? null : n;
        };

        let depId = tryParseInt(
            payload.departmentId ?? payload.department_id ?? payload.dept_id ?? payload.user_department ?? payload.userDepartment
        );

        if (depId == null && payload.department != null) {
            if (typeof payload.department === 'object') {
                depId = tryParseInt(
                    payload.department.id ?? payload.department.departmentId ?? payload.department.department_id ?? payload.department.dept_id
                );
            } else {
                depId = tryParseInt(payload.department);
            }
        }

        let depName =
            (
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

        if (depId != null) {
            payload.departmentId = depId;
            payload.department_id = depId;
            payload.dept_id = depId;
            payload.user_department = depId;
            payload.userDepartment = depId;

            payload.department = { id: depId, departmentId: depId };
            payload.userDepartment = { id: depId, departmentId: depId };
        }
        if (depName != null) {
            payload.departmentName = depName;
            payload.department_name = depName;
            payload.dept_name = depName;
            if (payload.department && typeof payload.department === 'object') {
                payload.department.name = depName;
                payload.department.departmentName = depName;
            }
            if (payload.userDepartment && typeof payload.userDepartment === 'object') {
                payload.userDepartment.name = depName;
                payload.userDepartment.departmentName = depName;
            }
        }

        // STRICT for create
        ensureDepartmentFieldsRequired({ departmentId: payload.departmentId, departmentName: payload.departmentName });

        if (DEBUG) console.log('[DEBUG] Create payload (items/user) =>', JSON.stringify(payload));

        const { data } = await ax('post', `${EXTERNAL_API_BASE}/user`, payload);

        let possiblyUpdated = data;
        if (
            (data?.departmentId == null && data?.user_department == null && (!data?.department || data?.department?.id == null)) &&
            depId != null
        ) {
            possiblyUpdated = await bestEffortSetDepartmentAfterCreate(data, depId, depName || undefined);
        }

        let out = possiblyUpdated;
        if (out && typeof out === 'object') {
            out = normalizeDepartmentFields(
                {
                    ...out,
                    departmentId:
                        out.departmentId ??
                        payload.departmentId ??
                        payload.department_id ??
                        payload.dept_id ??
                        payload.user_department ??
                        payload.userDepartment,
                    departmentName: out.departmentName ?? payload.departmentName ?? payload.department_name ?? payload.dept_name,
                },
                deptMaps
            );
        }

        res.status(201).json(out);
    } catch (err) {
        if (err.status === 400 && err.message === 'departmentId and departmentName must not be null or empty.') {
            return res.status(400).json({ message: err.message });
        }
        console.error('POST /items/user proxy error:', err?.response?.data || err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to create user via the external API.';
        res.status(status).json({ message });
    }
});

// Update user (same logic as PUT /api/users/:id)
app.put('/items/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deptMaps = await fetchDepartmentsMap();

        let sanitized = sanitizeUserPayload(req.body || {});
        sanitized = normalizeDepartmentFields(sanitized, deptMaps);

        // STRICT for update: department is required
        ensureDepartmentFieldsRequired({ departmentId: sanitized.departmentId, departmentName: sanitized.departmentName });

        if (sanitized.departmentId != null) {
            const depId = sanitized.departmentId;
            const depName = sanitized.departmentName || deptMaps.byId.get(depId) || null;
            sanitized.department = { id: depId, departmentId: depId };
            sanitized.userDepartment = { id: depId, departmentId: depId };
            if (depName) {
                sanitized.department.name = depName;
                sanitized.department.departmentName = depName;
                sanitized.userDepartment.name = depName;
                sanitized.userDepartment.departmentName = depName;
            }
        }

        if (DEBUG) console.log('[DEBUG] Update payload (items/user) =>', JSON.stringify(sanitized));

        const idParsed = Number.isNaN(parseInt(id, 10)) ? id : parseInt(id, 10);
        const body = directusSafeBody(sanitized);
        const withUserId = directusSafeBody({ ...sanitized, userId: idParsed, id: idParsed });

        const attempts = [
            { method: 'patch', url: `${EXTERNAL_API_BASE}/user/${id}`, body },
            { method: 'put', url: `${EXTERNAL_API_BASE}/user/${id}`, body },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user`, body: withUserId },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user/update`, body: withUserId },
        ];

        let lastErr = null;
        for (const a of attempts) {
            try {
                console.log(`Proxy update attempt (items/user) => ${a.method.toUpperCase()} ${a.url}`);
                const { data } = await ax(a.method, a.url, a.body);
                const out = normalizeDepartmentFields(
                    {
                        ...(data && typeof data === 'object' ? data : {}),
                        departmentId: data?.departmentId ?? sanitized.departmentId,
                        departmentName: data?.departmentName ?? sanitized.departmentName,
                    },
                    deptMaps
                );
                return res.json(out);
            } catch (e) {
                lastErr = e;
                const status = e.response?.status;
                const msg = e.response?.data?.message || e.message || '';
                console.warn(
                    `Update attempt failed (items/user, ${a.method.toUpperCase()} ${a.url}) => status ${status || 'n/a'} message: ${msg}`
                );
                if (status && [401, 403, 422].includes(status)) break;
            }
        }

        const status = lastErr?.response?.status || 500;
        const message = lastErr?.response?.data?.message || lastErr?.message || 'Failed to update user via the external API.';
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    } catch (err) {
        if (err.status === 400 && (err.message === 'If updating department, both departmentId and departmentName are required.' || err.message === 'departmentId and departmentName must not be null or empty.')) {
            return res.status(400).json({ message: err.message });
        }
        console.error('PUT /items/user/:id proxy error (wrapper):', err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to update user via the external API.';
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    }
});

// Also support PATCH for updating a user on Directus-style route
app.patch('/items/user/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deptMaps = await fetchDepartmentsMap();

        let sanitized = sanitizeUserPayload(req.body || {});
        sanitized = normalizeDepartmentFields(sanitized, deptMaps);

        // STRICT for update: department is required
        ensureDepartmentFieldsRequired({ departmentId: sanitized.departmentId, departmentName: sanitized.departmentName });

        if (sanitized.departmentId != null) {
            const depId = sanitized.departmentId;
            const depName = sanitized.departmentName || deptMaps.byId.get(depId) || null;
            sanitized.department = { id: depId, departmentId: depId };
            sanitized.userDepartment = { id: depId, departmentId: depId };
            if (depName) {
                sanitized.department.name = depName;
                sanitized.department.departmentName = depName;
                sanitized.userDepartment.name = depName;
                sanitized.userDepartment.departmentName = depName;
            }
        }

        if (DEBUG) console.log('[DEBUG] Update payload (PATCH items/user) =>', JSON.stringify(sanitized));

        const idParsed = Number.isNaN(parseInt(id, 10)) ? id : parseInt(id, 10);
        const body = directusSafeBody(sanitized);
        const withUserId = directusSafeBody({ ...sanitized, userId: idParsed, id: idParsed });

        const attempts = [
            { method: 'patch', url: `${EXTERNAL_API_BASE}/user/${id}`, body },
            { method: 'put', url: `${EXTERNAL_API_BASE}/user/${id}`, body },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user`, body: withUserId },
            { method: 'post', url: `${EXTERNAL_API_BASE}/user/update`, body: withUserId },
        ];

        let lastErr = null;
        for (const a of attempts) {
            try {
                console.log(`Proxy update attempt (PATCH items/user) => ${a.method.toUpperCase()} ${a.url}`);
                const { data } = await ax(a.method, a.url, a.body);
                const out = normalizeDepartmentFields(
                    {
                        ...(data && typeof data === 'object' ? data : {}),
                        departmentId: data?.departmentId ?? sanitized.departmentId,
                        departmentName: data?.departmentName ?? sanitized.departmentName,
                    },
                    deptMaps
                );
                return res.json(out);
            } catch (e) {
                lastErr = e;
                const status = e.response?.status;
                const msg = e.response?.data?.message || e.message || '';
                console.warn(
                    `Update attempt failed (PATCH items/user, ${a.method.toUpperCase()} ${a.url}) => status ${status || 'n/a'} message: ${msg}`
                );
                if (status && [401, 403, 422].includes(status)) break;
            }
        }

        const status = lastErr?.response?.status || 500;
        const message = lastErr?.response?.data?.message || lastErr?.message || 'Failed to update user via the external API.';
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    } catch (err) {
        if (err.status === 400 && (err.message === 'If updating department, both departmentId and departmentName are required.' || err.message === 'departmentId and departmentName must not be null or empty.')) {
            return res.status(400).json({ message: err.message });
        }
        console.error('PATCH /items/user/:id proxy error (wrapper):', err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data?.message || 'Failed to update user via the external API.';
        if (status === 403) {
            return res.status(403).json({
                message: message || 'Forbidden: You do not have permission to update this user.'
            });
        }
        return res.status(status).json({ message });
    }
});

// --- 6. Start the Server ---

// Lightweight diagnostics to verify token loading and Directus permissions
app.get('/api/debug/token-status', async (req, res) => {
    const base = EXTERNAL_API_BASE;
    const tokenLoaded = !!DIRECTUS_TOKEN;
    const result = { tokenLoaded, base, readOk: false, updateAuthOk: false, details: {} };

    try {
        const r = await ax('get', `${base}/user?limit=1`);
        result.readOk = r.status >= 200 && r.status < 300;
    } catch (e) {
        result.details.readErr = {
            status: e.response?.status || null,
            message: e.response?.data?.message || e.message,
        };
    }

    try {
        await ax('patch', `${base}/user/0`, {});
        result.updateAuthOk = true;
    } catch (e) {
        const st = e.response?.status;
        if (st === 404 || st === 405) {
            result.updateAuthOk = true;
        } else {
            result.details.updateErr = {
                status: st || null,
                message: e.response?.data?.message || e.message,
            };
        }
    }

    return res.json(result);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('--------------------------------------');
    console.log(`🚀 Advanced Server is running!`);
    console.log(`✅ Front-end served at: http://localhost:${PORT}`);
    console.log(`✅ Also reachable via Tailscale (if on your tailnet): http://100.119.3.44:${PORT}`);
    console.log(`✅ API requests are being proxied to: ${EXTERNAL_API_BASE}`);
    console.log(`✅ Using Directus token: ${DIRECTUS_TOKEN ? 'YES' : 'NO (writes will likely 403)'} `);
    console.log('--------------------------------------');
});
