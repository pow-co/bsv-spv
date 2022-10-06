import * as bsv from "bsv-minimal";
import lmdb from "node-lmdb";
import fs from "fs";

export default class DbMempool {
  pruneAfter: number;
  env: any;
  dbi_txs: lmdb.Dbi;
  dbi_tx_times: lmdb.Dbi;
  mempoolDir: string;
  readOnly: boolean;
  dbIsOpen: boolean;

  constructor({
    mempoolDir,
    pruneAfter = 1000 * 60 * 60 * 12, // After 12 hours
    readOnly = true,
  }: {
    mempoolDir: string;
    pruneAfter?: number;
    readOnly?: boolean;
  }) {
    if (!mempoolDir) throw Error(`Missing mempoolDir`);
    fs.mkdirSync(mempoolDir, { recursive: true });
    this.mempoolDir = mempoolDir;
    this.pruneAfter = pruneAfter;
    this.readOnly = readOnly;

    this.env = new lmdb.Env();
    this.env.open({
      path: mempoolDir,
      mapSize: 1 * 1024 * 1024 * 1024 * 1024, // 1TB mempool max
      maxDbs: 3,
      readOnly,
    });
    this.dbi_txs = this.env.openDbi({
      name: "txs",
      create: !readOnly,
      keyIsBuffer: true,
    });
    this.dbi_tx_times = this.env.openDbi({
      name: "tx_times",
      create: !readOnly,
      keyIsBuffer: true,
    });
    this.dbIsOpen = true;
    if (this.readOnly) this.close();
  }

  open() {
    if (this.dbIsOpen) return;
    this.env = new lmdb.Env();
    this.env.open({
      path: this.mempoolDir,
      mapSize: 1 * 1024 * 1024 * 1024 * 1024, // 1TB mempool max
      maxDbs: 3,
      readOnly: this.readOnly,
    });
    this.dbi_txs = this.env.openDbi({
      name: "txs",
      create: !this.readOnly,
      keyIsBuffer: true,
    });
    this.dbi_tx_times = this.env.openDbi({
      name: "tx_times",
      create: !this.readOnly,
      keyIsBuffer: true,
    });
    this.dbIsOpen = true;
  }

  close() {
    if (!this.dbIsOpen) return;
    try {
      this.dbi_txs.close();
    } catch (err) {}
    try {
      this.dbi_tx_times.close();
    } catch (err) {}
    try {
      this.env.close();
    } catch (err) {}
    this.dbIsOpen = false;
  }

  saveTxs(
    txsArray: bsv.Transaction[]
  ): Promise<{ txids: Buffer[]; size: number }> {
    return new Promise((resolve, reject) => {
      try {
        if (this.readOnly) throw Error(`DbMempool is set to readOnly`);
        const txids: Buffer[] = [];
        let size = 0;
        if (txsArray.length === 0) return resolve({ txids, size });
        const operations: any = [];
        const bw = new bsv.utils.BufferWriter();
        const date = Math.round(+new Date() / 1000);
        bw.writeUInt32LE(date);
        const time = bw.toBuffer();
        txsArray.map((tx) => {
          const txid = tx.getHash();
          size += tx.toBuffer().length;
          operations.push([this.dbi_txs, txid, tx.toBuffer(), null]);
          operations.push([this.dbi_tx_times, txid, time, null]);
        });
        this.env.batchWrite(
          operations,
          { keyIsBuffer: true },
          (err: any, results: number[]) => {
            if (err) return reject(err);
            txsArray.map(
              (tx, i) => results[i * 2] === 0 && txids.push(tx.getHash())
            );
            resolve({ txids, size });
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  saveTimes(txidArr: Buffer[]): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      try {
        if (this.readOnly) throw Error(`DbMempool is set to readOnly`);
        const txids: Buffer[] = [];
        if (txidArr.length === 0) return resolve(txids);
        const operations: any = [];
        const bw = new bsv.utils.BufferWriter();
        const date = Math.round(+new Date() / 1000);
        bw.writeUInt32LE(date);
        const time = bw.toBuffer();
        txidArr.map((txid) => {
          operations.push([this.dbi_tx_times, txid, time, null]);
        });
        this.env.batchWrite(
          operations,
          { keyIsBuffer: true },
          (err: any, results: number[]) => {
            if (err) return reject(err);
            txidArr.map((txid, i) => results[i] === 0 && txids.push(txid));
            resolve(txids);
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  delTxs(txidArr: Buffer[]): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      try {
        if (this.readOnly) throw Error(`DbMempool is set to readOnly`);
        const txids: Buffer[] = [];
        if (txidArr.length === 0) return resolve(txids);
        const operations: any = [];
        txidArr.map((txid) => {
          operations.push([this.dbi_txs, txid]);
          operations.push([this.dbi_tx_times, txid]);
        });
        this.env.batchWrite(
          operations,
          { keyIsBuffer: true },
          (err: any, results: number[]) => {
            if (err) return reject(err);
            txidArr.map((txid, i) => results[i * 2] === 0 && txids.push(txid));
            resolve(txids);
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  getTxids({
    olderThan,
    newerThan,
  }: {
    olderThan?: number;
    newerThan?: number;
  }) {
    this.open();
    const txn = this.env.beginTxn({ readOnly: true });
    const cursor: lmdb.Cursor<Buffer> = new lmdb.Cursor(
      txn,
      this.dbi_tx_times,
      {
        keyIsBuffer: true,
      }
    );
    const txids: Buffer[] = [];
    for (
      let txid = cursor.goToFirst();
      txid !== null;
      txid = cursor.goToNext()
    ) {
      if ((olderThan && olderThan >= 0) || (newerThan && newerThan >= 0)) {
        const buf = cursor.getCurrentBinary();
        if (buf) {
          const br = new bsv.utils.BufferReader(buf);
          const time = br.readUInt32LE() * 1000;
          if (
            (olderThan && olderThan > time) ||
            (newerThan && newerThan < time)
          ) {
            txids.push(Buffer.from(txid));
          }
        }
      } else {
        txids.push(Buffer.from(txid));
      }
    }
    cursor.close();
    txn.commit();
    if (this.readOnly) this.close();
    return txids;
  }

  getTx(txid: string, getTime = true) {
    const { txs, size, times } = this.getTxs([txid], getTime);
    const tx = txs[0];
    if (!tx) throw Error(`Not found`);
    const time = times[0];
    return { tx, time, size };
  }
  getTxs(
    txids?: string[] | Buffer[],
    getTime = false
  ): { txs: bsv.Transaction[]; size: number; times: (number | null)[] } {
    const txs = [];
    const times = [];
    let size = 0;
    this.open();
    const txn = this.env.beginTxn({ readOnly: true });
    if (txids) {
      for (let txid of txids) {
        const key = Buffer.isBuffer(txid) ? txid : Buffer.from(txid, "hex");
        const buf = txn.getBinary(this.dbi_txs, key, { keyIsBuffer: true });
        if (buf) {
          const tx = bsv.Transaction.fromBuffer(buf);
          txs.push(tx);
          size += buf.length;
        }
      }
    } else {
      const cursor: lmdb.Cursor<Buffer> = new lmdb.Cursor(txn, this.dbi_txs, {
        keyIsBuffer: true,
      });
      for (
        let txid = cursor.goToFirst();
        txid !== null;
        txid = cursor.goToNext()
      ) {
        const buf = cursor.getCurrentBinary();
        if (buf) {
          const tx = bsv.Transaction.fromBuffer(buf);
          txs.push(tx);
          size += buf.length;
        }
      }
      cursor.close();
    }
    if (getTime) {
      for (const tx of txs) {
        const buf = txn.getBinary(this.dbi_tx_times, tx.getHash(), {
          keyIsBuffer: true,
        });
        if (buf) {
          const br = new bsv.utils.BufferReader(buf);
          const time = br.readUInt32LE() * 1000;
          times.push(time);
        } else {
          times.push(null);
        }
      }
    }
    txn.commit();
    if (this.readOnly) this.close();
    return { txs, size, times };
  }

  pruneTxs(olderThan?: number) {
    if (!olderThan) olderThan = +new Date() - this.pruneAfter;
    const txids = this.getTxids({ olderThan });
    if (txids.length > 0) {
      return this.delTxs(txids);
    } else {
      return txids;
    }
  }
}