/**
 * The KnowledgeBase's message vocabulary, shared by its callers.
 *
 * The KnowledgeBase itself is the native C++/WASM package in
 * native/knowledge-base (spawned through the generic WasmAbject host); these
 * are the shapes its messages carry, so TypeScript callers can read them.
 */

import type { AbjectId } from './types.js';
import type { KnowledgeLearning } from './learning.js';

/** Well-known id and interface id of the per-workspace KnowledgeBase. */
export const KNOWLEDGE_BASE_ID = 'abjects:knowledge-base' as AbjectId;

/**
 * Tag marking a durable fact about the user (home location, name, role,
 * preferences). Profile-tagged facts are injected into every agent's context
 * unconditionally, so stable knowledge about the user surfaces even when the
 * task shares no keywords with it (keyword recall alone would miss it).
 */
export const PROFILE_TAG = 'profile';

export type KnowledgeType = 'learned' | 'fact' | 'insight' | 'reference' | 'pattern';

/**
 * Who authored an entry. Curation policy keys off this: 'user' entries are
 * never auto-evicted or auto-merged; only 'agent'/'reviewer' entries are
 * eligible for automated consolidation.
 */
export type KnowledgeOrigin = 'user' | 'agent' | 'reviewer' | 'scrum';

/** One knowledge entry as the KnowledgeBase presents it. */
export interface KnowledgeEntry {
  knowledgeRef?: string;
  learning?: KnowledgeLearning;
  id: string;
  title: string;
  content: string;
  type: KnowledgeType;
  tags: string[];
  origin: KnowledgeOrigin;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number;
  /** Times a reviewer judged this entry to have actually helped a task. */
  usefulCount: number;
  lastUsefulAt: number;
  /** Archived entries are hidden from recall/match but restorable. */
  archived: boolean;
  /**
   * The peer that authored this entry. Entries arriving over cross-peer sync
   * keep their origin peer's id, so a browser can attribute them and withhold
   * edit controls for what this peer does not own. Absent on entries written
   * before the field existed, which are read as local.
   */
  creatorPeerId?: string;
}
