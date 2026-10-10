/**
 * Client-side checks that mirror Amazon Textract's synchronous limits
 * (https://docs.aws.amazon.com/textract/latest/dg/limits-document.html): 10 MB, at most
 * 10,000 px per side, single-page PDF. The backend enforces the same rules again.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_SIDE = 10_000
export const ACCEPTED_TYPES = 'image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf'

export class FileProblem extends Error {}

function detectType(file: File): string {
  const type = file.type.toLowerCase()
  if (type) return type === 'image/jpg' ? 'image/jpeg' : type
  const name = file.name.toLowerCase()
  if (/\.jpe?g$/.test(name)) return 'image/jpeg'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.pdf')) return 'application/pdf'
  if (/\.hei[cf]$/.test(name)) return 'image/heic'
  return ''
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
}

/**
 * Re-encodes a photo so that (1) the pixels are upright, which keeps Textract's highlight boxes
 * aligned with what the browser shows, (2) location and camera metadata are removed, and
 * (3) it fits Textract's size limits.
 */
async function normalizeImage(file: File, type: 'image/jpeg' | 'image/png'): Promise<File> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new FileProblem("This image couldn't be opened. Try exporting it again as JPEG or PNG.")
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height), Math.sqrt(16_000_000 / (bitmap.width * bitmap.height)))
  if (type === 'image/png' && scale === 1 && file.size <= MAX_UPLOAD_BYTES) {
    bitmap.close()
    return file
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const outType = type === 'image/png' && scale < 1 ? 'image/png' : 'image/jpeg'
  for (const quality of [0.92, 0.85, 0.75]) {
    const blob = await canvasToBlob(canvas, outType, quality)
    if (blob && blob.size <= MAX_UPLOAD_BYTES) {
      const base = file.name.replace(/\.[^.]+$/, '') || 'receipt'
      return new File([blob], `${base}.${outType === 'image/png' ? 'png' : 'jpg'}`, { type: outType })
    }
  }
  throw new FileProblem('This photo is larger than 10 MB even after compressing. Try a lower-resolution photo.')
}

export async function prepareReceiptFile(file: File): Promise<File> {
  const type = detectType(file)
  if (type === 'image/heic' || type === 'image/heif') {
    throw new FileProblem(
      "HEIC photos can't be read yet. Export the photo as JPEG (on iPhone: Settings > Camera > Formats > Most Compatible) and upload it again.",
    )
  }
  if (type === 'image/tiff') throw new FileProblem('TIFF files aren\u2019t supported here. Save the receipt as JPEG, PNG, or PDF.')
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(type)) {
    throw new FileProblem('ReceiptReady accepts JPEG or PNG photos and single-page PDFs.')
  }
  if (file.size === 0) throw new FileProblem('This file is empty. Choose the receipt file again.')

  if (type === 'application/pdf') {
    if (file.size > MAX_UPLOAD_BYTES) throw new FileProblem('This PDF is larger than 10 MB. Try a compressed or single-page PDF.')
    return file.type ? file : new File([file], file.name, { type })
  }
  return normalizeImage(file, type as 'image/jpeg' | 'image/png')
}
