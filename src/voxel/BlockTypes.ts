// Space deliberately has one buildable material. Color belongs to each voxel
// instance, not to its type, so geometry and behavior stay software-defined.

export const DEFAULT_BLOCK_COLOR = 0xf2a93b;

// The keyboard palette is fixed at 9 slots (Shift+1..9).
export const PRESET_COLORS = [
  { hex: '#f2a93b', name: 'Amber Gold' },
  { hex: '#48dbfb', name: 'Sky Blue' },
  { hex: '#2ed573', name: 'Emerald Green' },
  { hex: '#eb4d4b', name: 'Flame Red' },
  { hex: '#a55eea', name: 'Starry Purple' },
  { hex: '#f5f6fa', name: 'Pure White' },
  { hex: '#2f3542', name: 'Obsidian' },
  { hex: '#ff6b81', name: 'Sakura Pink' },
  { hex: '#f1c40f', name: 'Bright Yellow' }
];

export const BlockTypes = {
  AIR: 0,
  COLOR_BLOCK: 1
};

export const BlockData = {
  [BlockTypes.AIR]: {
    id: BlockTypes.AIR,
    name: 'Air',
    solid: false,
    transparent: true,
    liquid: false,
    color: '#000000',
    sound: 'air'
  },
  [BlockTypes.COLOR_BLOCK]: {
    id: BlockTypes.COLOR_BLOCK,
    name: 'Color Block',
    solid: true,
    transparent: false,
    liquid: false,
    color: '#7c8799',
    sound: 'stone'
  }
};

export const INVENTORY_BLOCKS = [BlockTypes.COLOR_BLOCK];

export function normalizeColor(value, fallback = DEFAULT_BLOCK_COLOR) {
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xffffff;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace('#', ''), 16);
    if (Number.isFinite(parsed)) return parsed & 0xffffff;
  }
  return fallback;
}

export function colorToHex(value) {
  return `#${normalizeColor(value).toString(16).padStart(6, '0')}`;
}
