import { createHash } from "node:crypto";

export const DEFAULT_HRR_DIM = 1024;
const TWO_PI = Math.PI * 2;

export function encodeAtom(atom: string, dim = DEFAULT_HRR_DIM): Float64Array {
  const vector = new Float64Array(dim);

  for (let index = 0; index < dim; index += 1) {
    const hash = createHash("sha256").update(`${atom}:${index}`).digest();
    const value = hash.readUInt32BE(0) / 0xffffffff;
    vector[index] = value * TWO_PI - Math.PI;
  }

  return vector;
}

export function encodeText(text: string, dim = DEFAULT_HRR_DIM): Float64Array {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/)
    .filter((token) => token.length > 1)
    .slice(0, 64);

  if (!tokens.length) {
    return encodeAtom("__hrr_empty__", dim);
  }

  return bundle(...tokens.map((token) => encodeAtom(token, dim)));
}

export function encodeFact(content: string, entities: string[], dim = DEFAULT_HRR_DIM): Float64Array {
  const roleContent = encodeAtom("__hrr_role_content__", dim);
  const roleEntity = encodeAtom("__hrr_role_entity__", dim);
  const components = [bind(encodeText(content, dim), roleContent)];

  for (const entity of entities) {
    components.push(bind(encodeAtom(entity.toLowerCase(), dim), roleEntity));
  }

  return bundle(...components);
}

export function bind(left: Float64Array, right: Float64Array): Float64Array {
  const vector = new Float64Array(left.length);

  for (let index = 0; index < left.length; index += 1) {
    vector[index] = wrapPhase(left[index]! + right[index]!);
  }

  return vector;
}

export function unbind(left: Float64Array, right: Float64Array): Float64Array {
  const vector = new Float64Array(left.length);

  for (let index = 0; index < left.length; index += 1) {
    vector[index] = wrapPhase(left[index]! - right[index]!);
  }

  return vector;
}

export function bundle(...vectors: Float64Array[]): Float64Array {
  if (!vectors.length) {
    return new Float64Array();
  }

  const dim = vectors[0]!.length;
  const bundled = new Float64Array(dim);

  for (let index = 0; index < dim; index += 1) {
    let sin = 0;
    let cos = 0;

    for (const vector of vectors) {
      sin += Math.sin(vector[index]!);
      cos += Math.cos(vector[index]!);
    }

    bundled[index] = Math.atan2(sin, cos);
  }

  return bundled;
}

export function similarity(left: Float64Array, right: Float64Array): number {
  const dim = Math.min(left.length, right.length);

  if (!dim) {
    return 0;
  }

  let total = 0;

  for (let index = 0; index < dim; index += 1) {
    total += Math.cos(left[index]! - right[index]!);
  }

  return total / dim;
}

export function phasesToBytes(vector: Float64Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 8);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  for (let index = 0; index < vector.length; index += 1) {
    view.setFloat64(index * 8, vector[index]!, true);
  }

  return buffer;
}

export function bytesToPhases(data: Buffer | Uint8Array): Float64Array {
  const buffer = Buffer.from(data);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const vector = new Float64Array(buffer.byteLength / 8);

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = view.getFloat64(index * 8, true);
  }

  return vector;
}

function wrapPhase(value: number): number {
  let wrapped = value;

  while (wrapped > Math.PI) {
    wrapped -= TWO_PI;
  }

  while (wrapped <= -Math.PI) {
    wrapped += TWO_PI;
  }

  return wrapped;
}
