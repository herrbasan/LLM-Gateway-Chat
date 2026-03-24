// ============================================
// Image Store - Re-exports FileStore for compatibility
// ============================================
// TODO: Update callers to use fileStore directly
// ============================================

import { fileStore } from './file-store.js';

export const imageStore = fileStore;
