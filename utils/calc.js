// 数字 0-9 的加密查表，按个/十/百/千/万位分别查表后异或到基准值上
const ONES = [0x0000,0xC1C0,0x81C1,0x4001,0x01C3,0xC003,0x8002,0x41C2,0x01C6,0xC006];
const TENS = [0x0000,0x0190,0x0160,0x00F0,0x02C0,0x0350,0x03A0,0x0230,0x07C0,0x0650];
const HUNS = [0x0000,0x51C0,0xA1C0,0xF000,0x41C1,0x1001,0xE001,0xB1C1,0x81C2,0xD002];
const THOU = [0x0000,0x01FC,0x01B8,0x0044,0x0130,0x00CC,0x0088,0x0174,0x0260,0x039C];
const TTHO = [0x0000,0x3DC0,0x79C0,0x4400,0xF1C0,0xCC00,0x8800,0xB5C0,0xE1C1,0xDC01];
const BASE = 0x2BDC;

/**
 * 从设备名中提取水号。
 * 取名称里出现的所有数字，保留末 6 位并按 6 位右对齐，不足补前导 0。
 * @param {string} name 蓝牙广播名称
 * @returns {string|null} 6 位水号；名称中不含数字时返回 null
 */
function extractNumber(name) {
  const digits = name.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return digits.slice(-6).padStart(6, '0');
}

/**
 * 由水号推导设备密钥。
 * 水号补足 6 位后拆成数字数组，d[1]~d[5] 依次为万位至个位，逐位查表异或到基准值 0x2BDC。
 * @param {string|number} waterNumber 6 位水号
 * @returns {string} 4 位大写十六进制密钥
 */
function getDeviceKey(waterNumber) {
  const d = String(waterNumber).padStart(6, '0').split('').map(c => parseInt(c, 10));

  let key = BASE;
  key ^= ONES[d[5]];
  key ^= TENS[d[4]];
  key ^= HUNS[d[3]];
  key ^= THOU[d[2]];
  key ^= TTHO[d[1]];

  return key.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * 构造开阀指令：FE FE 09 B2 01 <密钥> 1B
 * @param {string|number} waterNumber 6 位水号
 * @returns {Uint8Array}
 */
function makeB2(waterNumber) {
  const hex = `FEFE09B201${getDeviceKey(waterNumber)}1B`;
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return arr;
}

/**
 * 由设备上报的用水量计算本次费用。
 * 上报值为 3 字节小端，需先翻转成大端；计数单位 0.1L，即 10000 计数 = 1 吨水。
 * @param {string} waterHex 6 个十六进制字符的用水量
 * @param {number} unitPrice 单价（元/吨）
 * @returns {number} 保留两位小数的金额
 */
function calcCost(waterHex, unitPrice = 25) {
  if (typeof waterHex !== 'string' || waterHex.length < 6) {
    throw new Error('waterHex must be a string with at least 6 hex characters');
  }

  const be = waterHex.slice(4, 6) + waterHex.slice(2, 4) + waterHex.slice(0, 2);
  const qty = parseInt(be, 16);
  const cost = unitPrice * (qty / 10) / 1000;

  return Math.round(cost * 100) / 100;
}

module.exports = {
  extractNumber,
  getDeviceKey,
  makeB2,
  calcCost
}