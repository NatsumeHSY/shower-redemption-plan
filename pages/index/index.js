const rLog = require("../../utils/log-record.js");
const calc = require("../../utils/calc.js");

const CMD_B0 = new Uint8Array([0xFE, 0xFE, 0x09, 0xB0, 0x01, 0x01, 0x00, 0x00]).buffer; // 握手
const CMD_B3 = new Uint8Array([0xFE, 0xFE, 0x09, 0xB3, 0x00, 0x00]).buffer; // 关阀
const CMD_B4 = new Uint8Array([0xFE, 0xFE, 0x09, 0xB4, 0x00, 0x00]).buffer; // 结算确认

// ArrayBuffer 转带空格的十六进制字符串，用于日志输出
function arrayBufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
}

// ArrayBuffer 转连续十六进制字符串，便于定位帧头并按偏移取值
function arrayBufferToHexStr(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return hex;
}

/**
 * 定位写特征与通知特征
 * @returns {Promise<[string|null, string|null, string|null]>} [serviceId, writeCharId, notifyCharId]
 */
async function findServiceUuid(deviceId, services) {
  const targetKey = "0000f1f0";
  for (const svc of services) {
    if (!svc.uuid.toLowerCase().includes(targetKey)) continue;

    const charRes = await wx.getBLEDeviceCharacteristics({
      deviceId,
      serviceId: svc.uuid
    });
    const chars = charRes.characteristics;

    let writeCharId = null;
    let notifyCharId = null;

    for (const ch of chars) {
      const p = ch.properties;
      if (p.write || p.writeNoResponse) {
        writeCharId = ch.uuid;
      }
      if (p.notify || p.indicate) {
        notifyCharId = ch.uuid;
      }
    }

    return [svc.uuid, writeCharId, notifyCharId];
  }
  return [null, null, null];
}

Page({
  data: {
    deviceList: [],
    logList: [],
    dotOpacity: "",
    bleStatus: "未连接",
    bleStatusColor: "warn",
    searchTime: 60,
    scrollAnchorId: "",
    valveOpen: false,
    waterNumber: "",       // 从设备名提取的水号
    lastCost: 0,           // 最近一次消费金额
    isOperating: false     // 操作进行中，用于拦截重复点击
  },

  startBlink() {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
    }
    let opacity = 1;
    let down = true;

    this.blinkTimer = setInterval(() => {
      if (down) {
        opacity -= 0.05;
        if (opacity <= 0.3) down = false;
      } else {
        opacity += 0.05;
        if (opacity >= 1) down = true;
      }
      this.setData({ dotOpacity: "background-color: rgba(0, 153, 255, " + opacity.toFixed(2) + ")" });
    }, 40);
  },

  stopBlink() {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
      this.setData({ dotOpacity: "" });
    }
  },

  async startSearch() {
    if (this.searchTimer) {
      wx.showToast({ title: "已经在扫描了", icon: "none" });
      return;
    }

    rLog(this, "info", "开始扫描周围的蓝牙控水器设备");

    const that = this;
    await this.stopSearch();

    try {
      await wx.openBluetoothAdapter();
    } catch (error) {
      if (error.errCode === 10001) {
        wx.showModal({
          title: "提示",
          content: "请先打开手机蓝牙",
          showCancel: false
        });
        wx.onBluetoothAdapterStateChange(resp => {
          if (resp.available && !resp.discovering) {
            that.startSearch();
            wx.offBluetoothAdapterStateChange();
          }
        });
        return;
      }
      console.error("蓝牙初始化失败:", error);
      rLog(this, "error", "蓝牙初始化失败: " + (typeof error === "object" ? JSON.stringify(error) : error));
      wx.showToast({ title: "蓝牙初始化失败", icon: "none" });
      return;
    }

    wx.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success() {
        that.setData({
          bleStatus: "正在扫描",
          bleStatusColor: "primary"
        });
        that.startBlink();

        wx.onBluetoothDeviceFound(resp => {
          resp.devices.forEach(device => {
            const deviceName = device.name || device.localName || "null";
            rLog(that, "info", "扫描到设备: " + device.deviceId + "(" + deviceName + ")");
            if (!deviceName.includes("Wa")) return;
            const list = that.data.deviceList;
            const exist = list.find(item => item.deviceId === device.deviceId);
            if (!exist) {
              list.push(device);
              that.setData({ deviceList: list });
            }
          });
        });

        that.searchTimer = setInterval(() => {
          const time = that.data.searchTime - 1;
          if (time < 0) {
            that.stopSearch();
            return;
          }
          that.setData({ searchTime: time });
        }, 1000);
      },
      fail(error) {
        console.error("扫描失败", error);
        rLog(that, "error", "扫描出错: " + (typeof error === "object" ? JSON.stringify(error) : error));
        wx.showToast({ title: "扫描启动失败", icon: "none" });
      }
    });
  },

  async stopSearch() {
    try {
      wx.stopBluetoothDevicesDiscovery();
      wx.offBluetoothDeviceFound();
      rLog(this, "info", "蓝牙扫描已停止");
      if (this.data.bleStatus === "正在扫描") {
        this.stopBlink();
        clearInterval(this.searchTimer);
        this.searchTimer = null;
        this.setData({
          bleStatus: "未连接",
          bleStatusColor: "warn",
          searchTime: 60
        });
      }
    } catch (error) {
      rLog(this, "error", "断开连接时出错: " + (typeof error === "object" ? JSON.stringify(error) : error));
      console.error(error);
    }
  },

  async connectDevice(e) {
    const device = e.currentTarget.dataset.device;
    const deviceId = device.deviceId;
    const deviceName = device.name || device.localName;
    await this._doConnect(deviceId, deviceName, false);
  },

  // 「连接上次的设备」：跳过扫描直连，并在连接成功后自动开阀
  async connectLastDevice() {
    const lastDeviceId = wx.getStorageSync("lastDeviceId");
    const lastDeviceName = wx.getStorageSync("lastDeviceName") || "";
    if (!lastDeviceId) {
      wx.showToast({ title: "没有上次连接的设备", icon: "none" });
      return;
    }
    rLog(this, "info", "快速重连上次设备: " + lastDeviceId);
    await this._doConnect(lastDeviceId, lastDeviceName, true);
  },

  /**
   * autoOpen 为 true 时，连接成功后自动开阀
   */
  async _doConnect(deviceId, deviceName, autoOpen) {
    if (this.connectedDeviceId) {
      await this.disconnectDevice();
    }

    await this.stopSearch();

    // 快速重连跳过了扫描流程，需要在这里补齐适配器初始化
    try {
      await wx.openBluetoothAdapter();
    } catch (error) {
      if (error.errCode === 10001) {
        wx.showModal({
          title: "提示",
          content: "请先打开手机蓝牙",
          showCancel: false
        });
        wx.onBluetoothAdapterStateChange(resp => {
          if (resp.available) {
            this._doConnect(deviceId, deviceName, autoOpen);
            wx.offBluetoothAdapterStateChange();
          }
        });
        return;
      }
      rLog(this, "error", "蓝牙初始化失败: " + JSON.stringify(error));
      wx.showToast({ title: "蓝牙初始化失败", icon: "none" });
      return;
    }

    rLog(this, "info", "尝试连接到 " + deviceId);
    wx.showLoading({ title: "正在连接设备...", mask: true });

    try {
      await wx.createBLEConnection({
        deviceId,
        timeout: 15000
      });
      rLog(this, "success", "成功连接到 " + deviceId);
      wx.hideLoading();
      wx.showToast({ title: "连接成功" });
      wx.vibrateLong();

      this.connectedDeviceId = deviceId;
      this.connectedDeviceName = deviceName;

      // 提取水号
      const waterNumber = calc.extractNumber(deviceName) || "";
      if (!waterNumber) {
        rLog(this, "warn", "无法从设备名提取水号: " + deviceName);
      }
      this.setData({
        waterNumber: waterNumber,
        bleStatus: waterNumber ? "已连接(水号 " + waterNumber + ")" : "已连接",
        bleStatusColor: "success",
        deviceList: []  // 清空列表，避免误触重复连接
      });

      // 供下次快速重连
      wx.setStorageSync("lastDeviceId", deviceId);
      wx.setStorageSync("lastDeviceName", deviceName);

      wx.onBLEConnectionStateChange((resp) => {
        if (!resp.connected) {
          rLog(this, "info", "设备断开连接 " + this.connectedDeviceId);
          wx.showToast({ title: "设备已断开", icon: "none" });
          this.connectedDeviceId = "";
          this.setData({
            valveOpen: false,
            bleStatus: "未连接",
            bleStatusColor: "warn"
          });
        }
      });

      await this.getDeviceServices(deviceId);

      if (autoOpen) {
        setTimeout(async() => {
          await this.doOpen();
        }, 100);
      }

    } catch (error) {
      rLog(this, "fail", "连接失败: " + (typeof error === "object" ? JSON.stringify(error) : error));
      wx.hideLoading();
      wx.showToast({ title: "连接失败", icon: "none" });
      console.error("连接失败: ", error);
    }
  },

  // 取出设备服务，定位写特征与通知特征并开启 notify
  async getDeviceServices(deviceId) {
    const resp = await wx.getBLEDeviceServices({ deviceId });
    const services = resp.services;

    const [targetSvcId, writeCharId, notifyCharId] = await findServiceUuid(deviceId, services);

    if (!targetSvcId) {
      rLog(this, "fail", "找不到 F1F0 服务");
      wx.showToast({ title: "未找到目标服务", icon: "none" });
      await this.disconnectDevice();
      return;
    }

    if (!writeCharId) {
      rLog(this, "fail", "找不到可写特征值");
      wx.showToast({ title: "未找到可写特征", icon: "none" });
      await this.disconnectDevice();
      return;
    }

    this.writeServiceId = targetSvcId;
    this.writeCharId = writeCharId;

    if (notifyCharId) {
      rLog(this, "info", "已定位通知特征, 开启 notify");
      wx.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId: targetSvcId,
        characteristicId: notifyCharId,
        state: true
      });

      // 只注册一次 notify 监听器
      if (!this._notifyRegistered) {
        this._notifyRegistered = true;
        wx.onBLECharacteristicValueChange(this._onNotifyValue.bind(this));
      }
    } else {
      rLog(this, "warn", "未找到通知特征, 将无法接收设备响应");
    }

    rLog(this, "success", "设备就绪");
  },

  // 解析设备上报的 FDFD 帧
  _onNotifyValue(resp) {
    const hex = arrayBufferToHexStr(resp.value);
    const idx = hex.indexOf("FDFD");
    if (idx < 0) return;

    const frame = hex.slice(idx);
    const cmd = frame.slice(6, 8);
    rLog(this, "debug", "← 设备上报: " + cmd);

    // doOpen / doClose 会挂起一个等待中的 Promise，命中期望指令时在此兑现
    if (this._pendingCmd && this._pendingCmd.expectedCmds.includes(cmd)) {
      clearTimeout(this._pendingTimeout);
      const resolve = this._pendingCmd.resolve;
      this._pendingCmd = null;

      if (cmd === "B3" && frame.length >= 40) {
        const waterHex = frame.slice(34, 40);
        rLog(this, "info", "用水量 hex: " + waterHex);
        resolve({ cmd, waterHex });
      } else {
        resolve({ cmd });
      }
      return;
    }

    // 无等待方时仅记录日志
    if (cmd === "B0" || cmd === "B1") {
      rLog(this, "info", "[" + cmd + "] 设备握手响应");
    } else if (cmd === "B2") {
      rLog(this, "info", "[B2] 开阀响应");
    } else if (cmd === "B3") {
      rLog(this, "info", "[B3] 关阀响应");
    }
  },

  /**
   * 等待设备回复指定指令
   * @param {string[]} expectedCmds 期望的指令码
   * @param {number} timeoutMs 超时毫秒数
   * @returns {Promise<{cmd: string, waterHex?: string}>}
   */
  _waitForCmd(expectedCmds, timeoutMs) {
    return new Promise((resolve, reject) => {
      this._pendingCmd = { expectedCmds, resolve, reject };
      this._pendingTimeout = setTimeout(() => {
        if (this._pendingCmd) {
          this._pendingCmd = null;
          rLog(this, "warn", "等待设备响应超时(" + expectedCmds.join("/") + ")");
          resolve({ cmd: "TIMEOUT" });  // 超时不抛异常, 继续流程
        }
      }, timeoutMs);
    });
  },

  async doOpen() {
    if (this.data.isOperating) {
      wx.showToast({ title: "操作进行中, 请稍候", icon: "none" });
      return;
    }
    if (this.data.valveOpen) {
      wx.showToast({ title: "阀门已经打开", icon: "none" });
      return;
    }
    if (!this.connectedDeviceId) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }
    if (!this.data.waterNumber) {
      wx.showToast({ title: "无法提取水号, 请确认设备名称", icon: "none" });
      return;
    }

    this.setData({ isOperating: true });
    rLog(this, "info", "开始开水流程");

    try {
      // B0 握手
      rLog(this, "info", "→ 发送 B0 握手...");
      this.sendBLEData(CMD_B0);

      const handshakeResp = await this._waitForCmd(["B0", "B1"], 5000);
      if (handshakeResp.cmd === "TIMEOUT") {
        rLog(this, "warn", "握手超时, 直接发 B2...");
      } else {
        rLog(this, "info", "[" + handshakeResp.cmd + "] 握手成功");
      }

      // B2 开阀，密钥由水号推导
      const b2 = calc.makeB2(this.data.waterNumber);
      const b2Hex = Array.from(b2).map(b => b.toString(16).padStart(2, "0").toUpperCase()).join("");
      rLog(this, "info", "→ 发送 B2 开阀: " + b2Hex);
      this.sendBLEData(b2.buffer);

      const openResp = await this._waitForCmd(["B2"], 10000);
      if (openResp.cmd === "TIMEOUT") {
        rLog(this, "warn", "开阀响应超时(可能已经开了)");
      } else {
        rLog(this, "success", "开阀成功！");
        wx.vibrateLong();
      }

      this.setData({ valveOpen: true });
    } catch (err) {
      rLog(this, "error", "开水流程出错: " + JSON.stringify(err));
      wx.showToast({ title: "开水失败", icon: "none" });
    } finally {
      this.setData({ isOperating: false });
    }
  },

  async doClose() {
    if (this.data.isOperating) {
      wx.showToast({ title: "操作进行中, 请稍候", icon: "none" });
      return;
    }
    if (!this.data.valveOpen) {
      wx.showToast({ title: "阀门尚未打开", icon: "none" });
      return;
    }
    if (!this.connectedDeviceId) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }

    this.setData({ isOperating: true });
    rLog(this, "info", "开始关水流程");

    try {
      // B3 关阀，设备会在回执里带上本轮用水量
      rLog(this, "info", "→ 发送 B3 关阀...");
      this.sendBLEData(CMD_B3);

      const closeResp = await this._waitForCmd(["B3"], 10000);
      let cost = 0;

      if (closeResp.waterHex) {
        cost = calc.calcCost(closeResp.waterHex);
        rLog(this, "info", "用水量 hex: " + closeResp.waterHex + ", 消费: ¥" + cost);
      } else if (closeResp.cmd === "B3") {
        rLog(this, "info", "收到 B3 响应但无法解析用水量");
      } else {
        rLog(this, "warn", "关阀响应超时");
      }

      // B4 结算确认
      rLog(this, "info", "→ 发送 B4 确认...");
      this.sendBLEData(CMD_B4);

      // 留出设备处理时间
      await new Promise(r => setTimeout(r, 500));

      this.setData({
        valveOpen: false,
        lastCost: cost
      });

      wx.showModal({
        title: "本次消费",
        content: "消费金额: ¥" + cost.toFixed(2),
        showCancel: false,
        success: () => {
          rLog(this, "info", "用户确认消费弹窗");
        }
      });

      await this.disconnectDevice();
      rLog(this, "success", "关水完成, 已断开连接");

    } catch (err) {
      rLog(this, "error", "关水流程出错: " + JSON.stringify(err));
      wx.showToast({ title: "关水异常", icon: "none" });
    } finally {
      this.setData({ isOperating: false });
    }
  },

  async disconnectDevice() {
    const deviceId = this.connectedDeviceId;
    if (!deviceId) return;
    try {
      await wx.closeBLEConnection({ deviceId });
      rLog(this, "info", "已断开设备 " + deviceId + " 连接");
    } catch (err) {
      rLog(this, "error", "断开连接失败: " + JSON.stringify(err));
    }

    // 释放全部监听与适配器，避免下次扫描时 BLE 栈残留旧状态
    this.connectedDeviceId = "";
    this.connectedDeviceName = "";
    wx.offBLEConnectionStateChange();
    wx.offBLECharacteristicValueChange();
    this._notifyRegistered = false;
    this.setData({
      bleStatus: "未连接",
      bleStatusColor: "warn",
      valveOpen: false
    });
    try {
      await wx.closeBluetoothAdapter();
    } catch (e) {
      // 忽略关闭失败
    }
  },

  sendBLEData(data) {
    const that = this;
    const deviceId = this.connectedDeviceId;
    const serviceId = this.writeServiceId;
    const characteristicId = this.writeCharId;

    if (!deviceId) {
      wx.showToast({ title: "还没有连接到任何设备", icon: "none" });
      return;
    }

    if (!serviceId || !characteristicId) {
      wx.showToast({ title: "服务未就绪, 请重新连接", icon: "none" });
      return;
    }

    wx.writeBLECharacteristicValue({
      deviceId: deviceId,
      serviceId: serviceId,
      characteristicId: characteristicId,
      value: data,
      fail: (error) => {
        rLog(that, "fail", "指令 " + arrayBufferToHex(data) + " 发送失败: " + (typeof error === "object" ? JSON.stringify(error) : error));
        console.error("指令发送失败", error);
        wx.showToast({ title: "指令发送失败", icon: "none" });
      }
    });
  },

  /**
   * 静默扫描指定名称的设备，不写入页面上的设备列表
   * @param {string} targetName 目标设备名
   * @param {number} timeoutMs 超时毫秒数
   * @returns {Promise<object|null>} 命中的设备，未找到返回 null
   */
  _scanForDeviceName(targetName, timeoutMs) {
    return new Promise((resolve) => {
      const that = this;
      let foundDevice = null;
      let scanTimer = null;

      // 设备发现回调
      const onFound = (resp) => {
        for (const device of resp.devices) {
          const name = device.name || device.localName || "";
          if (name.includes(targetName)) {
            foundDevice = device;
            rLog(that, "info", "静默扫描命中: " + name + " (" + device.deviceId + ")");
            clearTimeout(scanTimer);
            wx.offBluetoothDeviceFound(onFound);
            wx.stopBluetoothDevicesDiscovery();
            resolve(foundDevice);
            return;
          }
        }
      };

      wx.onBluetoothDeviceFound(onFound);

      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        success() {
          rLog(that, "info", "静默扫描已启动, 目标: " + targetName + ", 最长 " + (timeoutMs / 1000) + "s");
        },
        fail(err) {
          rLog(that, "error", "静默扫描启动失败: " + JSON.stringify(err));
          clearTimeout(scanTimer);
          wx.offBluetoothDeviceFound(onFound);
          resolve(null);
        }
      });

      scanTimer = setTimeout(() => {
        wx.offBluetoothDeviceFound(onFound);
        wx.stopBluetoothDevicesDiscovery();
        if (!foundDevice) {
          rLog(that, "warn", "静默扫描超时, 未找到设备: " + targetName);
        }
        resolve(null);
      }, timeoutMs);
    });
  },

  // 扫码后在本地解析出设备名，再静默扫描并连接
  async scanQRCode() {
    if (this.connectedDeviceId) {
      wx.showToast({ title: "请先断开设备连接", icon: "none" });
      return;
    }

    let scanResult;
    try {
      scanResult = await new Promise((resolve, reject) => {
        wx.scanCode({ success: resolve, fail: reject });
      });
    } catch (err) {
      rLog(this, "info", "用户取消扫码");
      return;
    }

    const qrCode = scanResult.result;
    rLog(this, "info", "扫码内容: " + qrCode);
    wx.showLoading({ title: "查询设备信息...", mask: true });

    if (!(qrCode.length === 10 && /^\d+$/.test(qrCode))) {
      wx.showToast({ title: "无效的设备二维码", icon: "none" });
      wx.hideLoading();
      return;
    }

    const deviceName = `Water${qrCode.slice(4)}`;
    rLog(this, "info", "解析到设备名称: " + deviceName);

    wx.showLoading({ title: "正在搜索设备...", mask: true });
    try {
      await wx.openBluetoothAdapter();
    } catch (error) {
      wx.hideLoading();
      if (error.errCode === 10001) {
        wx.showModal({ title: "提示", content: "请先打开手机蓝牙", showCancel: false });
        return;
      }
      rLog(this, "error", "蓝牙初始化失败: " + JSON.stringify(error));
      wx.showToast({ title: "蓝牙初始化失败", icon: "none" });
      return;
    }

    const device = await this._scanForDeviceName(deviceName, 15000);
    wx.hideLoading();

    if (!device) {
      wx.showToast({ title: "未找到设备 " + deviceName, icon: "none" });
      try { wx.stopBluetoothDevicesDiscovery(); } catch (e) { /* ignore */ }
      try { await wx.closeBluetoothAdapter(); } catch (e) { /* ignore */ }
      return;
    }

    await this._doConnect(device.deviceId, device.name || device.localName, false);
  },

  openMenu() {
    if (this.connectedDeviceId) {
      wx.showToast({ title: "请先断开设备连接", icon: "none" });
      return;
    }
    const that = this;
    wx.showActionSheet({
      itemList: ["扫码", "搜索"],
      success(resp) {
        const idx = resp.tapIndex;
        if (idx === 0) {
          that.scanQRCode();
        } else if (idx === 1) {
          that.startSearch();
        }
      }
    });
  },

  onUnload() {
    // 清理定时器与蓝牙监听
    this.stopBlink();
    if (this.searchTimer) {
      clearInterval(this.searchTimer);
      this.searchTimer = null;
    }
    if (this._pendingTimeout) {
      clearTimeout(this._pendingTimeout);
    }
    wx.offBluetoothDeviceFound();
    wx.offBLEConnectionStateChange();
    wx.offBLECharacteristicValueChange();
    this._notifyRegistered = false;
  }
});
