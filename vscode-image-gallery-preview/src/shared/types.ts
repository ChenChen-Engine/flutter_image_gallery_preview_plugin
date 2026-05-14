export type SourceType = 'android_res' | 'flutter_asset' | 'ios_asset';

export type PlatformType = 'android' | 'flutter' | 'ios';

export type MediaType = 'image' | 'audio' | 'video';

export type AssetKind =
  | 'png'
  | 'jpg'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'bmp'
  | 'svg'
  | 'lottie'
  | 'vector_xml'
  | 'pdf'
  | 'heic'
  | 'heif'
  | 'apng'
  | 'avif'
  | 'ico'
  | 'mp3'
  | 'm4a'
  | 'aac'
  | 'wav'
  | 'ogg'
  | 'opus'
  | 'flac'
  | 'amr'
  | 'mid'
  | 'midi'
  | 'caf'
  | 'mp4'
  | 'm4v'
  | 'mov'
  | 'webm'
  | 'mkv'
  | 'avi'
  | '3gp'
  | '3gpp'
  | 'xml'
  | 'other';

export interface ImageInfo {
  width: string;
  height: string;
  colorSpace: string;
  chromaSubsampling: string;
  bitDepth: string;
  compressionMode: string;
  streamSize: string;
  fileSize: string;
  format: string;
  absPath: string;
}

export interface MetadataRow {
  label: string;
  value: string;
}

export interface MetadataSection {
  title: string;
  rows: MetadataRow[];
}

export interface MediaMetadataInfo {
  mediaType: MediaType;
  source: string;
  sections: MetadataSection[];
  installHint?: {
    text: string;
    actionLabel: string;
    url: string;
  } | null;
}

export interface GalleryAssetItem {
  sourceType: SourceType;
  platform: PlatformType;
  workspaceKind: PlatformType | 'mixed' | 'unknown';
  projectName: string;
  projectPath: string;
  projectRelPath: string;
  isPrimaryProject: boolean;
  moduleName: string;
  modulePath: string;
  moduleRelPath: string;
  isPrimaryModule: boolean;
  groupPath: string;
  copyToken: string;
  md5: string;
  formatFamily: AssetKind;
  isAnimated: boolean;
  mediaType: MediaType;
  durationMillis: number | null;
  resourceRootPath: string;
  absPath: string;
  relPath: string;
  format: string;
  width: number | null;
  height: number | null;
  qualifier: string;
  mtime: number;
  kind: AssetKind;
  imageInfo?: ImageInfo;
  mediaInfo?: MediaMetadataInfo;
}
