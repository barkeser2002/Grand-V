// Explicit supported appearance schema; never persist arbitrary native commands.
import { HttpError } from './http-util.js';
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const integer = (v, min, max) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new HttpError(400, 'Görünüm değeri geçersiz.');
  return v;
};
const only = (v, keys) => {
  if (!object(v) || Object.keys(v).some((k) => !keys.includes(k))) throw new HttpError(400, 'Görünüm alanı geçersiz.');
};
export function cleanAppearance(value, gender) {
  only(value, ['model', 'components', 'props', 'hair', 'headBlend', 'overlays']);
  const model = gender === 'f' ? 'mp_f_freemode_01' : 'mp_m_freemode_01';
  if (value.model !== undefined && value.model !== model) throw new HttpError(400, 'Karakter modeli cinsiyetle uyuşmuyor.');
  const out = { model, components: [], props: [], overlays: [] };
  for (const [key, max, keys] of [['components', 12, ['slot', 'drawable', 'texture', 'palette']], ['props', 8, ['slot', 'drawable', 'texture']]]) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > max) throw new HttpError(400, 'Görünüm listesi geçersiz.');
    const seen = new Set();
    out[key] = list.map((v) => {
      only(v, keys);
      const slot = integer(v.slot, 0, max - 1);
      if (seen.has(slot)) throw new HttpError(400, 'Görünüm slotu tekrarlanamaz.');
      seen.add(slot);
      const row = { slot, drawable: integer(v.drawable, key === 'props' ? -1 : 0, 1023), texture: integer(v.texture ?? 0, 0, 255) };
      if (key === 'components') row.palette = integer(v.palette ?? 0, 0, 3);
      return row;
    });
  }
  if (value.hair !== undefined) {
    only(value.hair, ['color', 'highlight']);
    out.hair = { color: integer(value.hair.color, 0, 63), highlight: integer(value.hair.highlight ?? 0, 0, 63) };
  }
  if (value.headBlend !== undefined) {
    only(value.headBlend, ['mother', 'father', 'shapeMix', 'skinMix']);
    const mix = (v) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new HttpError(400, 'Yüz karışımı geçersiz.'); return v; };
    out.headBlend = { mother: integer(value.headBlend.mother, 0, 45), father: integer(value.headBlend.father, 0, 45), shapeMix: mix(value.headBlend.shapeMix), skinMix: mix(value.headBlend.skinMix) };
  }
  if (value.overlays !== undefined) {
    if (!Array.isArray(value.overlays) || value.overlays.length > 13) throw new HttpError(400, 'Yüz katmanları geçersiz.');
    const seen = new Set();
    out.overlays = value.overlays.map((v) => {
      only(v, ['slot', 'index', 'opacity']);
      const slot = integer(v.slot, 0, 12);
      if (seen.has(slot) || typeof v.opacity !== 'number' || !Number.isFinite(v.opacity) || v.opacity < 0 || v.opacity > 1) throw new HttpError(400, 'Yüz katmanı geçersiz.');
      seen.add(slot);
      return { slot, index: integer(v.index, 0, 255), opacity: v.opacity };
    });
  }
  return out;
}
