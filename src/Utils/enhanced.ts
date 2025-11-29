// @ts-check
/**
 * Baileys Enhanced - Mejora automática con JsDoc typing
 * Compatible con proyectos TypeScript estrictos
 * @module baileys-enhanced
 */
import makeWASocket from '../Socket';
import chalk from 'chalk';
import type { GroupParticipant } from '../Types';


// ==================== TYPES (JSDoc) ====================

/**
 * @typedef {Object} CacheEntry
 * @property {string} jid
 * @property {number} time
 */
/**
 * @typedef {Object} GroupCacheEntry
 * @property {EnhancedGroupMetadata} data
 * @property {number} time
 */
/**
 * @typedef {Object} EnhancedParticipant
 * @property {string} jid
 * @property {string | null} admin
 * @property {boolean} isAdmin
 */
/**
 * @typedef {Object} EnhancedGroupMetadata
 * @property {string} id
 * @property {string} subject
 * @property {string | null} owner
 * @property {EnhancedParticipant[]} participants
 * @property {EnhancedParticipant[]} admins
 * @property {number} size
 */
/**
 * @typedef {Object} MessageInfo
 * @property {string} chat
 * @property {string} sender
 * @property {boolean} isGroup
 * @property {string} id
 */

// ==================== CONFIGURACIÓN ====================

const SECURE_PAIRING = { code: 'CLOUDEVX', locked: true };

/** @type {Map<string, CacheEntry>} */
const jidCache = new Map();

/** @type {Map<string, GroupCacheEntry>} */
const groupCache = new Map();

const CONFIG = {
    TTL: 5 * 60 * 1000,
    MAX_SIZE: 500
};

// ==================== CORE FUNCTIONS ====================

/**
 * Limpia JID automáticamente
 * @param {string | null | undefined} jid
 * @returns {string | null}
 */
export function autoCleanJid(jid: string | null | undefined): string | null {
    if (!jid) return null;
    try {
        const result = String(jid).trim().split(':')[0]?.split('/')[0];
        return result ?? null;
    } catch {
        return null;
    }
}

/**
 * Detecta si es un LID
 * @param {string | null | undefined} jid
 * @returns {boolean}
 */
export function isLidJid(jid: string | null | undefined): boolean {
    if (!jid) return false;
    const str = String(jid);
    return str.includes('@lid') || str.includes('lid:');
}

/**
 * Valida formato de JID
 * @param {string | null | undefined} jid
 * @returns {boolean}
 */
export function isValidJid(jid: string | null | undefined): boolean {
    if (!jid) return false;
    const cleaned = autoCleanJid(jid);
    if (!cleaned || cleaned === '' || isLidJid(cleaned)) return false;
    return /^(\d{10,15})@(s.whatsapp.net|g.us)$/.test(cleaned);
}

/**
 * Procesa array de JIDs
 * @param {any} conn
 * @param {(string | null | undefined)[]} jids
 * @returns {Promise<(string|null)[]>}
 */
export async function autoProcessJids(conn: any, jids: (string | null | undefined)[]): Promise<(string | null)[]> {
    if (!Array.isArray(jids)) return [];

    const promises = jids.map(async (jid) => {
        try {
            if (!jid) return null;

            const cleaned = autoCleanJid(jid);
            if (isLidJid(cleaned)) {
                // This is intended for individual JID resolution, not batching.
                // For group metadata, getEnhancedGroupMetadata should be used.
                return await conn.signalRepository.lidMapping.getPNForLID(cleaned);
            }

            return isValidJid(cleaned) ? cleaned : null;
        } catch (err) {
            console.error('Error processing JID:', jid, err);
            return null;
        }
    });

    const results = await Promise.all(promises);
    return results;
}

/**
 * Obtiene metadata mejorada de un grupo, resolviendo LIDs en lote.
 * @param {any} conn
 * @param {string} groupJid
 * @returns {Promise<EnhancedGroupMetadata | null>}
 */
export async function getEnhancedGroupMetadata(conn: any, groupJid: string): Promise<any | null> {
    const cached = groupCache.get(groupJid);
    if (cached && (Date.now() - cached.time) < CONFIG.TTL) {
        return cached.data;
    }

    const metadata = await conn.groupMetadata(groupJid);
    if (!metadata?.participants) throw new Error('Invalid metadata');

    const participantLIDs = metadata.participants
        .map((p: GroupParticipant) => autoCleanJid(p.id))
        .filter((j: string | null): j is string => !!j && isLidJid(j));

    const lidPnMap = new Map<string, string>();
    if (participantLIDs.length > 0) {
        const resolved = await conn.signalRepository.lidMapping.getPNsForLIDs(participantLIDs);
        if (resolved) {
            for (const { lid, pn } of resolved) {
                lidPnMap.set(autoCleanJid(lid)!, autoCleanJid(pn)!);
            }
        }
    }

    const processedParticipants = metadata.participants.map((p: GroupParticipant) => {
        let jid: string | null = autoCleanJid(p.id);

        if (jid && isLidJid(jid)) {
            const resolvedPn = lidPnMap.get(jid);
            if (resolvedPn) {
                jid = resolvedPn;
            } else {
                console.error('Failed to resolve LID JID for participant:', p.id);
                // We don't return null here, so we can still see the participant in the list
            }
        }

        if (!isValidJid(jid)) {
            console.error('Invalid JID for participant:', p.id, '->', jid);
            // Don't filter out, just log the error
        }

        return {
            jid: jid || p.id, // Fallback to original ID if all else fails
            admin: p.admin || null,
            isAdmin: ['admin', 'superadmin'].includes(p.admin || '')
        };
    });

    const validParticipants = processedParticipants.filter((p: { jid: string | null; }) => !!p.jid);

    const enhancedMetadata = {
        id: metadata.id,
        subject: metadata.subject,
        owner: metadata.owner ? autoCleanJid(metadata.owner) : null,
        participants: validParticipants,
        admins: validParticipants.filter((p: { isAdmin: boolean; }) => p.isAdmin),
        size: validParticipants.length,
    };

    groupCache.set(groupJid, { data: enhancedMetadata, time: Date.now() });

    if (groupCache.size > CONFIG.MAX_SIZE) {
        const firstKey = groupCache.keys().next().value;
        groupCache.delete(firstKey);
    }

    return enhancedMetadata;
}
