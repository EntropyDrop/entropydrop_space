/**
 * Single source of truth for Space world, entity, inventory, and selector constants.
 *
 * All boundary spans, voxel capacities, payload sizes, and coordinate limits are
 * unified here to match the Space world maximum height (256).
 */

// ============================================================================
// 1. World & Single-Axis Boundary Limits
// ============================================================================

/** Space world maximum height in standard 1 m blocks. */
export const MAX_WORLD_HEIGHT = 256;

/** Maximum bounding span (inclusive) for any entity or contraption along any single axis. */
export const MAX_ENTITY_BOUNDS = 256;

/** Maximum bounding span for selector boxes and connected selections (mirrors MAX_ENTITY_BOUNDS). */
export const MAX_SELECTION_BOUNDS = MAX_ENTITY_BOUNDS;

/**
 * Maximum absolute coordinate allowed in portable resource imports and entity transforms.
 * Evaluates to MAX_ENTITY_BOUNDS * 2 ([-512, 512]).
 */
export const MAX_IMPORT_COORDINATE = MAX_ENTITY_BOUNDS * 2;

/** Maximum absolute vector component for portable positions / pivots. */
export const MAX_PORTABLE_VECTOR_COMPONENT = MAX_ENTITY_BOUNDS;


// ============================================================================
// 2. Voxel & Capacity Budgets
// ============================================================================

/** Maximum number of blocks/voxels an entity may contain. */
export const MAX_ENTITY_BLOCKS = 65_536;

/** Maximum number of blocks/voxels allowed in a single inventory item (block set or entity). */
export const MAX_INVENTORY_BLOCKS = 65_536;

/** Maximum number of voxels that can be selected or copied at once by the Selector tool. */
export const MAX_SELECTION_BLOCKS = 65_536;

/** Maximum number of voxels output by the model voxelizer. */
export const MAX_OUTPUT_BLOCKS = 65_536;

/**
 * Maximum virtual/real micro voxels selectable by the Selector tool in micro mode.
 * Aligned with MAX_SELECTION_BLOCKS (65,536).
 */
export const MAX_MICRO_SELECTION_CELLS = 65_536;

/**
 * Maximum number of standard 1 m blocks that can be subdivided into microblocks (512 each)
 * during a single micro edit (Del / F / P). Evaluates to 128 (128 * 512 = 65,536 voxels).
 */
export const MAX_MICRO_MATERIALIZE_BLOCKS = 128;

/** Maximum dense grid cell allocation in ModelVoxelizer (32 M cells comfortably fits 256^3 with padding). */
export const MAX_GRID_CELLS = 32 * 1024 * 1024;


// ============================================================================
// 3. Storage, Packaging & Entity Hierarchy Limits
// ============================================================================

/** Maximum byte length of an encoded Protobuf inventory resource (8 MiB). */
export const MAX_INVENTORY_IMPORT_BYTES = 8 * 1024 * 1024;

/** Maximum number of slots per category in the player backpack. */
export const MAX_BACKPACK_SLOTS_PER_CATEGORY = 99;

/** Maximum character length for inventory item names. */
export const MAX_INVENTORY_NAME_LENGTH = 80;

/** Maximum character length for component IDs. */
export const MAX_COMPONENT_ID_LENGTH = 64;

/** Maximum component hierarchy nodes in a single entity. */
export const MAX_ENTITY_COMPONENTS = 64;

/** Maximum hierarchy nesting depth in an entity tree. */
export const MAX_ENTITY_HIERARCHY_DEPTH = 16;

/** Maximum physical constraints in a single entity. */
export const MAX_ENTITY_CONSTRAINTS = 256;

/** Maximum constraints allowed when importing an inventory item. */
export const MAX_INVENTORY_CONSTRAINTS = 256;

/** Maximum script size per component (64 KiB). */
export const MAX_INVENTORY_SCRIPT_BYTES = 64 * 1024;

/** Maximum total script bytes across all components of an entity (512 KiB). */
export const MAX_INVENTORY_TOTAL_SCRIPT_BYTES = 512 * 1024;

/** Maximum total script bytes allowed on a runtime entity (512 KiB). */
export const MAX_ENTITY_TOTAL_SCRIPT_BYTES = 512 * 1024;

/** Maximum persisted script state payload in bytes (64 KiB). */
export const SCRIPT_STATE_LIMIT_BYTES = 64 * 1024;


// ============================================================================
// 4. Selector, Bulk Editing & Rendering Limits
// ============================================================================

/** Torus curvature subdivision segment limit for selection box rendering (safety cap to prevent GPU vertex bloat). */
export const MAX_SELECTION_BEND_SEGMENTS = 64;

/** Threshold of voxels above which operations switch to progressive frame-sliced bulk editing. */
export const BULK_EDIT_THRESHOLD = 256;

/** Maximum voxel operations processed per animation frame during bulk editing. */
export const BULK_EDIT_MAX_OPERATIONS_PER_FRAME = 1024;


// ============================================================================
// 5. Physics & Numerical Safety Caps
// ============================================================================

/** Maximum allowable mass for portable bodies (kg). */
export const MAX_PORTABLE_BODY_MASS = 1e12;

/** Maximum force / velocity vector component for body physics. */
export const MAX_BODY_VECTOR_COMPONENT = 1e12;

/** Maximum constraint parameter value (distance, angle, stiffness). */
export const MAX_PORTABLE_CONSTRAINT_VALUE = 10_000;
