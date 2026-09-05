export interface SurfaceZoneSnapshot {
  zoneX: number;
  zoneZ: number;
  seed: number;
  terrainGeneratorVersion: number;
  sourceTerrainRevision: number;
  zoneSizeChunks: number;
  samplesPerChunkAxis: number;
  heightsMicro: Uint16Array;
  colors: Uint8Array;
}
