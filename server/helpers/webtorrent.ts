import * as createTorrent from 'create-torrent'
import { createWriteStream, ensureDir, remove, writeFile } from 'fs-extra'
import * as magnetUtil from 'magnet-uri'
import * as parseTorrent from 'parse-torrent'
import { dirname, join } from 'path'
import * as WebTorrent from 'webtorrent'
import { isArray } from '@server/helpers/custom-validators/misc'
import { WEBSERVER } from '@server/initializers/constants'
import { generateTorrentFileName, getVideoFilePath } from '@server/lib/video-paths'
import { MVideo } from '@server/types/models/video/video'
import { MVideoFile, MVideoFileRedundanciesOpt } from '@server/types/models/video/video-file'
import { MStreamingPlaylistVideo } from '@server/types/models/video/video-streaming-playlist'
import { CONFIG } from '../initializers/config'
import { promisify2 } from './core-utils'
import { logger } from './logger'
import { generateVideoImportTmpPath } from './utils'
import { extractVideo } from './video'

const createTorrentPromise = promisify2<string, any, any>(createTorrent)

async function downloadWebTorrentVideo (target: { magnetUri: string, torrentName?: string }, timeout: number) {
  const id = target.magnetUri || target.torrentName
  let timer

  const path = generateVideoImportTmpPath(id)
  logger.info('Importing torrent video %s', id)

  const directoryPath = join(CONFIG.STORAGE.TMP_DIR, 'webtorrent')
  await ensureDir(directoryPath)

  return new Promise<string>((res, rej) => {
    const webtorrent = new WebTorrent()
    let file: WebTorrent.TorrentFile

    const torrentId = target.magnetUri || join(CONFIG.STORAGE.TORRENTS_DIR, target.torrentName)

    const options = { path: directoryPath }
    const torrent = webtorrent.add(torrentId, options, torrent => {
      if (torrent.files.length !== 1) {
        if (timer) clearTimeout(timer)

        for (const file of torrent.files) {
          deleteDownloadedFile({ directoryPath, filepath: file.path })
        }

        return safeWebtorrentDestroy(webtorrent, torrentId, undefined, target.torrentName)
          .then(() => rej(new Error('Cannot import torrent ' + torrentId + ': there are multiple files in it')))
      }

      file = torrent.files[0]

      // FIXME: avoid creating another stream when https://github.com/webtorrent/webtorrent/issues/1517 is fixed
      const writeStream = createWriteStream(path)
      writeStream.on('finish', () => {
        if (timer) clearTimeout(timer)

        safeWebtorrentDestroy(webtorrent, torrentId, { directoryPath, filepath: file.path }, target.torrentName)
          .then(() => res(path))
          .catch(err => logger.error('Cannot destroy webtorrent.', { err }))
      })

      file.createReadStream().pipe(writeStream)
    })

    torrent.on('error', err => rej(err))

    timer = setTimeout(() => {
      const err = new Error('Webtorrent download timeout.')

      safeWebtorrentDestroy(webtorrent, torrentId, file ? { directoryPath, filepath: file.path } : undefined, target.torrentName)
        .then(() => rej(err))
        .catch(destroyErr => {
          logger.error('Cannot destroy webtorrent.', { err: destroyErr })
          rej(err)
        })

    }, timeout)
  })
}

async function createTorrentAndSetInfoHash (
  videoOrPlaylist: MVideo | MStreamingPlaylistVideo,
  videoFile: MVideoFile
) {
  const video = extractVideo(videoOrPlaylist)

  const options = {
    // Keep the extname, it's used by the client to stream the file inside a web browser
    name: `${video.name} ${videoFile.resolution}p${videoFile.extname}`,
    createdBy: 'PeerTube',
    announceList: [
      [ WEBSERVER.WS + '://' + WEBSERVER.HOSTNAME + ':' + WEBSERVER.PORT + '/tracker/socket' ],
      [ WEBSERVER.URL + '/tracker/announce' ]
    ],
    urlList: [ videoFile.getFileUrl(video) ]
  }

  const torrent = await createTorrentPromise(getVideoFilePath(videoOrPlaylist, videoFile), options)

  const torrentFilename = generateTorrentFileName(videoOrPlaylist, videoFile.resolution)
  const torrentPath = join(CONFIG.STORAGE.TORRENTS_DIR, torrentFilename)
  logger.info('Creating torrent %s.', torrentPath)

  await writeFile(torrentPath, torrent)

  // Remove old torrent file if it existed
  if (videoFile.hasTorrent()) {
    await remove(join(CONFIG.STORAGE.TORRENTS_DIR, videoFile.torrentFilename))
  }

  const parsedTorrent = parseTorrent(torrent)
  videoFile.infoHash = parsedTorrent.infoHash
  videoFile.torrentFilename = torrentFilename
}

function generateMagnetUri (
  video: MVideo,
  videoFile: MVideoFileRedundanciesOpt,
  trackerUrls: string[]
) {
  const xs = videoFile.getTorrentUrl()
  const announce = trackerUrls
  let urlList = [ videoFile.getFileUrl(video) ]

  const redundancies = videoFile.RedundancyVideos
  if (isArray(redundancies)) urlList = urlList.concat(redundancies.map(r => r.fileUrl))

  const magnetHash = {
    xs,
    announce,
    urlList,
    infoHash: videoFile.infoHash,
    name: video.name
  }

  return magnetUtil.encode(magnetHash)
}

// ---------------------------------------------------------------------------

export {
  createTorrentPromise,
  createTorrentAndSetInfoHash,
  generateMagnetUri,
  downloadWebTorrentVideo
}

// ---------------------------------------------------------------------------

function safeWebtorrentDestroy (
  webtorrent: WebTorrent.Instance,
  torrentId: string,
  downloadedFile?: { directoryPath: string, filepath: string },
  torrentName?: string
) {
  return new Promise<void>(res => {
    webtorrent.destroy(err => {
      // Delete torrent file
      if (torrentName) {
        logger.debug('Removing %s torrent after webtorrent download.', torrentId)
        remove(torrentId)
          .catch(err => logger.error('Cannot remove torrent %s in webtorrent download.', torrentId, { err }))
      }

      // Delete downloaded file
      if (downloadedFile) deleteDownloadedFile(downloadedFile)

      if (err) logger.warn('Cannot destroy webtorrent in timeout.', { err })

      return res()
    })
  })
}

function deleteDownloadedFile (downloadedFile: { directoryPath: string, filepath: string }) {
  // We want to delete the base directory
  let pathToDelete = dirname(downloadedFile.filepath)
  if (pathToDelete === '.') pathToDelete = downloadedFile.filepath

  const toRemovePath = join(downloadedFile.directoryPath, pathToDelete)

  logger.debug('Removing %s after webtorrent download.', toRemovePath)
  remove(toRemovePath)
    .catch(err => logger.error('Cannot remove torrent file %s in webtorrent download.', toRemovePath, { err }))
}
