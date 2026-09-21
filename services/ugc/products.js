/* ============================================
   JARVIS — UGC Product Library
   Small JSON store for reusable product records
   used by UGC Studio. A product is metadata the
   user supplied (name, brand, benefits, claims to
   avoid, reference images); nothing here invents
   claims, ingredients, certifications or
   performance guarantees.
   SPDX-License-Identifier: MIT
   Copyright (c) 2026 not-so-jarvis.
   ============================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// An explicit path keeps the tests hermetic (they never touch data/).
const PRODUCTS_PATH = process.env.UGC_PRODUCTS_PATH || path.join(DATA_DIR, 'ugc-products.json');

const PRODUCT_FIELDS = [
    'name', 'brand', 'category', 'description', 'usageInstructions'
];
const PRODUCT_LIST_FIELDS = [
    'keyBenefits', 'keySellingPoints', 'brandColors', 'claimsToAvoid'
];
const MAX_FIELD_LENGTH = 1200;
const MAX_NAME_LENGTH = 120;
const MAX_LIST_ITEMS = 12;
const MAX_REFERENCE_IMAGES = 6;

let products = null;

function loadProducts() {
    if (products) return products;
    try {
        const raw = fs.readFileSync(PRODUCTS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        products = Array.isArray(parsed.products) ? parsed.products : [];
    } catch (err) {
        products = [];
    }
    return products;
}

function saveProducts() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PRODUCTS_PATH, JSON.stringify({
        updatedAt: new Date().toISOString(),
        products
    }, null, 2), 'utf-8');
}

function clean(value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max || MAX_FIELD_LENGTH);
}

function cleanList(value) {
    if (Array.isArray(value)) {
        return value.map((v) => clean(v, 200)).filter(Boolean).slice(0, MAX_LIST_ITEMS);
    }
    // A comma / newline separated string is accepted for convenience.
    return String(value || '')
        .split(/[,;\n]/)
        .map((v) => clean(v, 200))
        .filter(Boolean)
        .slice(0, MAX_LIST_ITEMS);
}

// Only image paths already served by the app are accepted, so a product can
// never store a remote or traversal URL.
function cleanReferenceImages(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
        const url = clean(item, 500);
        if (!/^\/(?:images|generated)\/[A-Za-z0-9._%-]+$/.test(url)) continue;
        if (!out.includes(url)) out.push(url);
        if (out.length >= MAX_REFERENCE_IMAGES) break;
    }
    return out;
}

function sanitizeProduct(value) {
    const src = value && typeof value === 'object' ? value : {};
    const out = { name: clean(src.name, MAX_NAME_LENGTH) };
    // A product without a name is unusable as a UGC subject.
    if (!out.name) return null;
    for (const field of PRODUCT_FIELDS) {
        if (field === 'name') continue;
        out[field] = clean(src[field]);
    }
    for (const field of PRODUCT_LIST_FIELDS) {
        out[field] = cleanList(src[field]);
    }
    out.referenceImages = cleanReferenceImages(src.referenceImages);
    return out;
}

function makeId() {
    return 'prod_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function list() {
    return loadProducts().slice();
}

function get(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return loadProducts().find((p) => p.id === key) || null;
}

// Case-insensitive name match used to bind a product named in a brief to a
// saved library entry without asking the user again.
function findByName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    const all = loadProducts();
    return all.find((p) => String(p.name || '').trim().toLowerCase() === key)
        || all.find((p) => String(p.name || '').trim().toLowerCase().includes(key))
        || all.find((p) => key.includes(String(p.name || '').trim().toLowerCase()) && String(p.name || '').trim())
        || null;
}

function create(value) {
    const cleanProduct = sanitizeProduct(value);
    if (!cleanProduct) {
        const err = new Error('A product needs at least a name.');
        err.code = 'product_invalid';
        throw err;
    }
    loadProducts();
    const now = new Date().toISOString();
    const product = Object.assign({ id: makeId(), createdAt: now, updatedAt: now }, cleanProduct);
    products.push(product);
    saveProducts();
    return product;
}

function update(id, patch) {
    const product = get(id);
    if (!product) return null;
    const merged = sanitizeProduct(Object.assign({}, product, patch || {}));
    if (!merged) {
        const err = new Error('A product needs at least a name.');
        err.code = 'product_invalid';
        throw err;
    }
    Object.assign(product, merged, { updatedAt: new Date().toISOString() });
    saveProducts();
    return product;
}

function remove(id) {
    const key = String(id || '').trim();
    const index = loadProducts().findIndex((p) => p.id === key);
    if (index === -1) return false;
    products.splice(index, 1);
    saveProducts();
    return true;
}

// The compact snapshot embedded in a UGC project so a later step never depends
// on the library entry still existing.
function snapshot(product) {
    if (!product) return null;
    return {
        id: product.id,
        name: product.name || '',
        brand: product.brand || '',
        category: product.category || '',
        description: product.description || '',
        keyBenefits: product.keyBenefits || [],
        keySellingPoints: product.keySellingPoints || [],
        targetAudience: product.targetAudience || '',
        brandColors: product.brandColors || [],
        usageInstructions: product.usageInstructions || '',
        claimsToAvoid: product.claimsToAvoid || [],
        referenceImages: product.referenceImages || []
    };
}

module.exports = {
    PRODUCT_FIELDS,
    PRODUCT_LIST_FIELDS,
    PRODUCTS_PATH,
    sanitizeProduct,
    list,
    get,
    findByName,
    create,
    update,
    remove,
    snapshot,
    resetForTests: () => { products = null; }
};
