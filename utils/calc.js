const ONES = [0x0000,0xC1C0,0x81C1,0x4001,0x01C3,0xC003,0x8002,0x41C2,0x01C6,0xC006];
const TENS = [0x0000,0x0190,0x0160,0x00F0,0x02C0,0x0350,0x03A0,0x0230,0x07C0,0x0650];
const HUNS = [0x0000,0x51C0,0xA1C0,0xF000,0x41C1,0x1001,0xE001,0xB1C1,0x81C2,0xD002];
const THOU = [0x0000,0x01FC,0x01B8,0x0044,0x0130,0x00CC,0x0088,0x0174,0x0260,0x039C];
const TTHO = [0x0000,0x3DC0,0x79C0,0x4400,0xF1C0,0xCC00,0x8800,0xB5C0,0xE1C1,0xDC01];
const BASE = 0x2BDC;

function extractNumber(name) {
  // 1. 提取所有数字
  const digits = name.replace(/[^0-9]/g, '');
  // 无数字返回 null
  if (!digits) return null;
  // 截取最后6位
  const last6 = digits.slice(-6);
  // 不足6位前面补0, 凑满6位
  return last6.padStart(6, '0');
}

function getDeviceKey(waterNumber) {
    // 补0到6位, 同 zfill(6)
    const str = String(waterNumber).padStart(6, '0');
    // 转数字数组 d[0] 万位, d[5]个位
    const d = str.split('').map(c => parseInt(c, 10));
    
    let key = BASE;
    key ^= ONES[d[5]];
    key ^= TENS[d[4]];
    key ^= HUNS[d[3]];
    key ^= THOU[d[2]];
    key ^= TTHO[d[1]];

    // 转4位大写十六进制, 不足补前导0
    return key.toString(16).toUpperCase().padStart(4, '0');
}

function makeB2(waterNumber) {
  const key = getDeviceKey(waterNumber);
  const hex = `FEFE09B201${key}1B`;
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
      arr[i/2] = parseInt(hex.substring(i, i+2), 16);
  }
  return arr;
}

function calcCost(waterHex, unitPrice = 25) {
  // 确保输入是字符串且长度足够
  if (typeof waterHex !== 'string' || waterHex.length < 6) {
      throw new Error('waterHex must be a string with at least 6 hex characters');
  }

  // 重新组合字节顺序: 原第3字节 + 第2字节 + 第1字节(小端转大端)
  const be = waterHex.slice(4, 6) + waterHex.slice(2, 4) + waterHex.slice(0, 2);

  // 将十六进制字符串转为整数
  const qty = parseInt(be, 16);

  // 计算费用: (qty / 10) / 1000  = qty / 10000, 再乘以单价
  const cost = unitPrice * (qty / 10) / 1000;

  // 四舍五入保留两位小数(处理浮点精度)
  return Math.round(cost * 100) / 100;
}

module.exports = {
  extractNumber,
  getDeviceKey,
  makeB2,
  calcCost
}