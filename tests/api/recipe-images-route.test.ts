import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_IMAGE_BYTES } from '@/lib/images/limits'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  addPhoto: vi.fn(),
  makeCover: vi.fn(),
  removePhoto: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))
vi.mock('@/lib/db', () => ({ db: { marker: 'db' } }))
vi.mock('@/lib/storage/vercel-blob', () => ({ createVercelBlobStore: () => ({ marker: 'store' }) }))
vi.mock('@/lib/images/photos', () => ({
  addPhoto: mocks.addPhoto,
  makeCover: mocks.makeCover,
  removePhoto: mocks.removePhoto,
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))

const { POST } = await import('@/app/api/recipes/[id]/images/route')
const { PATCH, DELETE } = await import('@/app/api/recipes/[id]/images/[imageId]/route')

const PHOTO = {
  id: 'img1', role: 'user', isCover: false,
  blobUrl: 'memory://a.webp', thumbUrl: 'memory://a-thumb.webp', width: 800, height: 600,
}

function upload(form: FormData) {
  return POST(
    new Request('https://app.example.com/api/recipes/r1/images', { method: 'POST', body: form }),
    { params: Promise.resolve({ id: 'r1' }) },
  )
}

function oneFile(bytes = new Uint8Array([1, 2, 3]), name = 'dish.jpg') {
  const form = new FormData()
  form.append('file', new File([bytes], name, { type: 'image/jpeg' }))
  return form
}

const imageParams = { params: Promise.resolve({ id: 'r1', imageId: 'img1' }) }

function patch(body: string) {
  return PATCH(
    new Request('https://app.example.com/api/recipes/r1/images/img1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body,
    }),
    imageParams,
  )
}

function del() {
  return DELETE(new Request('https://app.example.com/api/recipes/r1/images/img1', { method: 'DELETE' }), imageParams)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'user-1' } })
  mocks.addPhoto.mockResolvedValue({ status: 'ok', slug: 'egg-korma', photo: PHOTO })
  mocks.makeCover.mockResolvedValue({ status: 'ok', slug: 'egg-korma' })
  mocks.removePhoto.mockResolvedValue({ status: 'ok', slug: 'egg-korma' })
})

describe('POST /api/recipes/[id]/images', () => {
  it('stores the file and returns the new photo', async () => {
    const res = await upload(oneFile(new Uint8Array([9, 8, 7])))

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ photo: PHOTO })
    expect(mocks.addPhoto).toHaveBeenCalledWith({ marker: 'db' }, { marker: 'store' }, 'r1', new Uint8Array([9, 8, 7]))
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/recipes/egg-korma')
  })

  it('returns 401 for a signed-out caller and reads nothing', async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await upload(oneFile())
    expect(res.status).toBe(401)
    expect(mocks.addPhoto).not.toHaveBeenCalled()
  })

  it('refuses a request with no file', async () => {
    const res = await upload(new FormData())
    expect(res.status).toBe(400)
    expect(mocks.addPhoto).not.toHaveBeenCalled()
  })

  it('refuses two files in one request', async () => {
    const form = oneFile()
    form.append('file', new File([new Uint8Array([1])], 'second.jpg', { type: 'image/jpeg' }))
    expect((await upload(form)).status).toBe(400)
  })

  it('refuses a text field posing as the file', async () => {
    const form = new FormData()
    form.append('file', 'not a file')
    expect((await upload(form)).status).toBe(400)
  })

  it('refuses an oversized file before reading it', async () => {
    const res = await upload(oneFile(new Uint8Array(MAX_IMAGE_BYTES + 1)))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too_large' })
    expect(mocks.addPhoto).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 'not_found' }, 404, 'not_found'],
    [{ status: 'rejected', reason: 'too_large' }, 413, 'too_large'],
    [{ status: 'rejected', reason: 'unsupported' }, 415, 'unsupported'],
    [{ status: 'rejected', reason: 'storage_failed' }, 502, 'storage_failed'],
  ])('maps %o to %i', async (result, status, error) => {
    mocks.addPhoto.mockResolvedValue(result)
    const res = await upload(oneFile())
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error })
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/recipes/[id]/images/[imageId]', () => {
  it('makes the photo the cover', async () => {
    const res = await patch('{"cover":true}')
    expect(res.status).toBe(200)
    expect(mocks.makeCover).toHaveBeenCalledWith({ marker: 'db' }, 'r1', 'img1')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/recipes/egg-korma')
  })

  it.each(['{"cover":false}', '{}', '{"cover":true,"extra":1}', 'not json'])('refuses %s', async (body) => {
    expect((await patch(body)).status).toBe(400)
    expect(mocks.makeCover).not.toHaveBeenCalled()
  })

  it('returns 404 for a photo that is not this recipe’s', async () => {
    mocks.makeCover.mockResolvedValue({ status: 'not_found' })
    expect((await patch('{"cover":true}')).status).toBe(404)
  })

  it('returns 401 for a signed-out caller', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await patch('{"cover":true}')).status).toBe(401)
    expect(mocks.makeCover).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/recipes/[id]/images/[imageId]', () => {
  it('deletes the photo', async () => {
    const res = await del()
    expect(res.status).toBe(204)
    expect(mocks.removePhoto).toHaveBeenCalledWith({ marker: 'db' }, { marker: 'store' }, 'r1', 'img1')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/recipes/egg-korma')
  })

  it('returns 502 when storage refused, so the client knows the photo is still there', async () => {
    mocks.removePhoto.mockResolvedValue({ status: 'storage_failed' })
    const res = await del()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'storage_failed' })
  })

  it('returns 404 for a photo that is not this recipe’s', async () => {
    mocks.removePhoto.mockResolvedValue({ status: 'not_found' })
    expect((await del()).status).toBe(404)
  })

  it('returns 401 for a signed-out caller', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await del()).status).toBe(401)
    expect(mocks.removePhoto).not.toHaveBeenCalled()
  })
})
