/**
 * FileTransfer capability — chunked peer-to-peer file transfer over DataChannels.
 *
 * Sends files in chunks with progress tracking, supports cancel, and handles
 * receive-side reassembly. Uses the existing PeerTransport DataChannel
 * infrastructure for the actual transfer.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { Abject } from '../../core/abject.js';
import { Capabilities } from '../../core/capability.js';
import { require as precondition } from '../../core/contracts.js';
import { request as createRequest, event as createEvent } from '../../core/message.js';
import type { PeerId } from '../../core/identity.js';

const FILE_TRANSFER_INTERFACE: InterfaceId = 'abjects:file-transfer';

export const FILE_TRANSFER_ID = 'abjects:file-transfer' as AbjectId;

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

interface TransferState {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  peerId: string;
  direction: 'send' | 'receive';
  status: 'pending' | 'accepted' | 'transferring' | 'completed' | 'cancelled' | 'error';
  bytesTransferred: number;
  chunks: Map<number, string>; // For receive: chunkIndex -> base64 data
  totalChunks: number;
  startedAt: number;
}

export class FileTransfer extends Abject {
  private peerRegistryId?: AbjectId;
  private transfers: Map<string, TransferState> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'FileTransfer',
        description:
          'Peer-to-peer file transfer over WebRTC DataChannels. Chunks files with progress tracking and reassembly.',
        version: '1.0.0',
        interface: {
          id: FILE_TRANSFER_INTERFACE,
          name: 'FileTransfer',
          description: 'P2P file transfer operations',
          methods: [
            {
              name: 'sendFile',
              description: 'Initiate a file transfer to a peer',
              parameters: [
                { name: 'peerId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target peer ID' },
                { name: 'fileName', type: { kind: 'primitive', primitive: 'string' }, description: 'File name' },
                { name: 'fileData', type: { kind: 'primitive', primitive: 'string' }, description: 'Base64-encoded file data' },
                { name: 'mimeType', type: { kind: 'primitive', primitive: 'string' }, description: 'MIME type', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'string' }, // transfer ID
            },
            {
              name: 'acceptTransfer',
              description: 'Accept a pending incoming file transfer',
              parameters: [
                { name: 'transferId', type: { kind: 'primitive', primitive: 'string' }, description: 'Transfer ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'rejectTransfer',
              description: 'Reject a pending incoming file transfer',
              parameters: [
                { name: 'transferId', type: { kind: 'primitive', primitive: 'string' }, description: 'Transfer ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'cancelTransfer',
              description: 'Cancel an in-progress file transfer',
              parameters: [
                { name: 'transferId', type: { kind: 'primitive', primitive: 'string' }, description: 'Transfer ID' },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            {
              name: 'getTransferStatus',
              description: 'Get the status of a file transfer',
              parameters: [
                { name: 'transferId', type: { kind: 'primitive', primitive: 'string' }, description: 'Transfer ID' },
              ],
              returns: { kind: 'reference', reference: 'TransferStatus' },
            },
            {
              name: 'listTransfers',
              description: 'List all active/recent file transfers',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'TransferStatus' } },
            },
            {
              name: 'getFileData',
              description: 'Get the received file data (after transfer completes)',
              parameters: [
                { name: 'transferId', type: { kind: 'primitive', primitive: 'string' }, description: 'Transfer ID' },
              ],
              returns: { kind: 'primitive', primitive: 'string' }, // base64
            },
          ],
          events: [
            {
              name: 'transferRequested',
              description: 'An incoming file transfer request was received',
              payload: { kind: 'object', properties: {
                transferId: { kind: 'primitive', primitive: 'string' },
                peerId: { kind: 'primitive', primitive: 'string' },
                fileName: { kind: 'primitive', primitive: 'string' },
                fileSize: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'transferProgress',
              description: 'Progress update for an active file transfer',
              payload: { kind: 'object', properties: {
                transferId: { kind: 'primitive', primitive: 'string' },
                bytesTransferred: { kind: 'primitive', primitive: 'number' },
                totalBytes: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'transferCompleted',
              description: 'A file transfer completed successfully',
              payload: { kind: 'object', properties: {
                transferId: { kind: 'primitive', primitive: 'string' },
                fileName: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'transferCancelled',
              description: 'A file transfer was cancelled',
              payload: { kind: 'object', properties: {
                transferId: { kind: 'primitive', primitive: 'string' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [
          Capabilities.FILE_TRANSFER_SEND,
          Capabilities.FILE_TRANSFER_RECEIVE,
        ],
        tags: ['system', 'capability', 'file-transfer'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('sendFile', async (msg: AbjectMessage) => {
      const { peerId, fileName, fileData, mimeType } = msg.payload as {
        peerId: string; fileName: string; fileData: string; mimeType?: string;
      };
      precondition(peerId !== '', 'peerId must not be empty');
      precondition(fileName !== '', 'fileName must not be empty');
      precondition(fileData !== '', 'fileData must not be empty');
      return this.initiateSend(peerId, fileName, fileData, mimeType ?? 'application/octet-stream');
    });

    this.on('acceptTransfer', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      return this.acceptTransferImpl(transferId);
    });

    this.on('rejectTransfer', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      return this.rejectTransferImpl(transferId);
    });

    this.on('cancelTransfer', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      return this.cancelTransferImpl(transferId);
    });

    this.on('getTransferStatus', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      return this.getStatus(transferId);
    });

    this.on('listTransfers', async () => {
      return Array.from(this.transfers.values()).map(t => this.formatStatus(t));
    });

    this.on('getFileData', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      return this.getReceivedData(transferId);
    });

    // Internal: handle incoming transfer protocol messages from remote peers
    this.on('_fileOffer', async (msg: AbjectMessage) => {
      this.handleFileOffer(msg);
    });

    this.on('_fileAccepted', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      this.handleFileAccepted(transferId);
    });

    this.on('_fileRejected', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      this.handleFileRejected(transferId);
    });

    this.on('_fileChunk', async (msg: AbjectMessage) => {
      this.handleFileChunk(msg);
    });

    this.on('_fileCancelled', async (msg: AbjectMessage) => {
      const { transferId } = msg.payload as { transferId: string };
      this.handleFileCancelled(transferId);
    });
  }

  protected override async onInit(): Promise<void> {
    this.peerRegistryId = await this.discoverDep('PeerRegistry') ?? undefined;
  }

  // ==========================================================================
  // Send side
  // ==========================================================================

  private async initiateSend(
    peerId: string,
    fileName: string,
    fileData: string,
    mimeType: string,
  ): Promise<string> {
    const transferId = crypto.randomUUID();
    const fileSize = fileData.length; // base64 length
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    const transfer: TransferState = {
      id: transferId, fileName, fileSize, mimeType, peerId,
      direction: 'send', status: 'pending',
      bytesTransferred: 0, chunks: new Map(),
      totalChunks, startedAt: Date.now(),
    };
    // Store the full data temporarily for chunked sending
    transfer.chunks.set(-1, fileData); // -1 = full data placeholder
    this.transfers.set(transferId, transfer);

    // Send offer to remote peer
    this.send(createEvent(this.id, FILE_TRANSFER_ID, '_fileOffer', {
      transferId, fileName, fileSize, mimeType, fromPeerId: peerId,
    }));

    return transferId;
  }

  private handleFileAccepted(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.direction !== 'send') return;

    transfer.status = 'transferring';
    this.sendChunks(transfer);
  }

  private handleFileRejected(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.direction !== 'send') return;

    transfer.status = 'cancelled';
    transfer.chunks.clear();
    this.changed('transferCancelled', { transferId });
  }

  private async sendChunks(transfer: TransferState): Promise<void> {
    const fullData = transfer.chunks.get(-1) as string;
    if (!fullData) return;

    for (let i = 0; i < transfer.totalChunks; i++) {
      if (transfer.status !== 'transferring') return; // cancelled

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fullData.length);
      const chunk = fullData.slice(start, end);

      this.send(createEvent(this.id, FILE_TRANSFER_ID, '_fileChunk', {
        transferId: transfer.id,
        chunkIndex: i,
        data: chunk,
        totalChunks: transfer.totalChunks,
      }));

      transfer.bytesTransferred = end;
      this.changed('transferProgress', {
        transferId: transfer.id,
        bytesTransferred: transfer.bytesTransferred,
        totalBytes: transfer.fileSize,
      });

      // Small yield to avoid blocking
      if (i % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    transfer.status = 'completed';
    transfer.chunks.clear();
    this.changed('transferCompleted', {
      transferId: transfer.id, fileName: transfer.fileName,
    });
  }

  // ==========================================================================
  // Receive side
  // ==========================================================================

  private handleFileOffer(msg: AbjectMessage): void {
    const { transferId, fileName, fileSize, mimeType } = msg.payload as {
      transferId: string; fileName: string; fileSize: number;
      mimeType: string; fromPeerId: string;
    };

    const transfer: TransferState = {
      id: transferId, fileName, fileSize, mimeType,
      peerId: msg.routing.from,
      direction: 'receive', status: 'pending',
      bytesTransferred: 0, chunks: new Map(),
      totalChunks: Math.ceil(fileSize / CHUNK_SIZE),
      startedAt: Date.now(),
    };
    this.transfers.set(transferId, transfer);

    this.changed('transferRequested', {
      transferId, peerId: transfer.peerId, fileName, fileSize,
    });
  }

  private acceptTransferImpl(transferId: string): boolean {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.status !== 'pending' || transfer.direction !== 'receive') return false;

    transfer.status = 'accepted';
    // Notify sender
    this.send(createEvent(this.id, FILE_TRANSFER_ID, '_fileAccepted', { transferId }));
    transfer.status = 'transferring';
    return true;
  }

  private rejectTransferImpl(transferId: string): boolean {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.status !== 'pending' || transfer.direction !== 'receive') return false;

    transfer.status = 'cancelled';
    this.send(createEvent(this.id, FILE_TRANSFER_ID, '_fileRejected', { transferId }));
    this.transfers.delete(transferId);
    return true;
  }

  private handleFileChunk(msg: AbjectMessage): void {
    const { transferId, chunkIndex, data, totalChunks } = msg.payload as {
      transferId: string; chunkIndex: number; data: string; totalChunks: number;
    };

    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.direction !== 'receive') return;
    if (transfer.status !== 'transferring' && transfer.status !== 'accepted') return;

    transfer.status = 'transferring';
    transfer.chunks.set(chunkIndex, data);
    transfer.bytesTransferred += data.length;

    this.changed('transferProgress', {
      transferId,
      bytesTransferred: transfer.bytesTransferred,
      totalBytes: transfer.fileSize,
    });

    // Check if all chunks received
    if (transfer.chunks.size === totalChunks) {
      transfer.status = 'completed';
      this.changed('transferCompleted', {
        transferId, fileName: transfer.fileName,
      });
    }
  }

  private handleFileCancelled(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    transfer.status = 'cancelled';
    transfer.chunks.clear();
    this.changed('transferCancelled', { transferId });
  }

  private cancelTransferImpl(transferId: string): boolean {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return false;

    transfer.status = 'cancelled';
    transfer.chunks.clear();
    this.send(createEvent(this.id, FILE_TRANSFER_ID, '_fileCancelled', { transferId }));
    this.changed('transferCancelled', { transferId });
    return true;
  }

  // ==========================================================================
  // Status
  // ==========================================================================

  private getStatus(transferId: string): object | null {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return null;
    return this.formatStatus(transfer);
  }

  private formatStatus(t: TransferState): object {
    return {
      id: t.id, fileName: t.fileName, fileSize: t.fileSize,
      mimeType: t.mimeType, peerId: t.peerId,
      direction: t.direction, status: t.status,
      bytesTransferred: t.bytesTransferred,
      progress: t.fileSize > 0 ? t.bytesTransferred / t.fileSize : 0,
      startedAt: t.startedAt,
    };
  }

  private getReceivedData(transferId: string): string | null {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.direction !== 'receive' || transfer.status !== 'completed') {
      return null;
    }

    // Reassemble chunks in order
    const parts: string[] = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
      const chunk = transfer.chunks.get(i);
      if (!chunk) return null;
      parts.push(chunk);
    }
    return parts.join('');
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## FileTransfer Usage Guide

### Send a file

  const ftId = await dep('FileTransfer');
  const transferId = await call(ftId, 'sendFile', {
    peerId: 'remote-peer-id',
    fileName: 'hello.txt',
    fileData: btoa('Hello, World!'),
    mimeType: 'text/plain',
  });

### Listen for incoming transfers

  // Subscribe to events from FileTransfer
  // On 'transferRequested' event: { transferId, peerId, fileName, fileSize }
  await call(ftId, 'acceptTransfer', { transferId });
  // or
  await call(ftId, 'rejectTransfer', { transferId });

### Get received file data

  const base64Data = await call(ftId, 'getFileData', { transferId });

### Cancel a transfer

  await call(ftId, 'cancelTransfer', { transferId });

### Get transfer status

  const status = await call(ftId, 'getTransferStatus', { transferId });
  // { id, fileName, fileSize, status, bytesTransferred, progress }`;
  }
}
