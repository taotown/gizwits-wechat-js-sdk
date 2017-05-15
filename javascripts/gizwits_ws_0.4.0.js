/**
 * @fileOverview  Gizwits WeChat JavaScript SDK
 * @version 0.4.0
 * @author Trevor(trevortao@gizwits.com)
 */

var LEN_DID = 22; //设备识别码长度
var LEN_PRODUCT_KEY = 32; //产品标识码长度
var P0_TYPE_CUSTOM = "custom"; //自定义P0
var P0_TYPE_ATTRS_V4 = "attrs_v4"; //数据点协议P0
var PROTOCOL_VER = [0x00, 0x00, 0x00, 0x03]; //P0协议版本号
var RETRY_WAIT_TIME = 5000; //用户重登/Websocket重连间隔(毫秒)
var RETRY_SEND_TIME = 2000; //重连Websocket后重新下发指令的时间间隔(毫秒)

var CMD_TRANS_BUSINESS_RESP = 0x93;
var P0_CMD_REPORT_SUBDEVICE_STATUS = 0x10; //子设备上下线状态变更通知(中控)
var P0_CMD_ADD_SUBDEVICE_RESP = 0x57; //添加子设备应答(中控)
var P0_CMD_DELETE_SUBDEVICE_RESP = 0x59; //删除子设备(中控)
var P0_CMD_GET_SUBDEVICE_LIST_RESP = 0x5B; //获取子设备列表应答(中控)
var P0_CMD_REPORT_SUBDEVICE_LIST = 0x5C; //子设备列表变更通知(中控)

/**
 * Gizwits WeChat JavaScript SDK对象构造函数
 * 
 * @class
 * @param {String} apiHost      指定OpenAPI域名
 * @param {String} wechatOpenID 指定微信OpenID
 * @param {String} gizwitsAppID 指定应用标识码
 */
function GizwitsWS(apiHost, wechatOpenID, gizwitsAppID) {
    //外部回调
    this.onInit = undefined;
    this.onError = undefined;
    this.onConnected = undefined;
    this.onReceivedRaw = undefined;
    this.onReceivedAttrs = undefined;
    this.onUpdateSubDevices = undefined;
    this.onOnlineStatusChanged = undefined;

    //内部变量
    this._gloabSN = 1;
    this._keepalive = 180;
    this._subDevices = {};
    this._connections = {};
    this._boundDevices = {};
    this._apiHost = apiHost;
    this._userID = undefined;
    this._appID = gizwitsAppID;
    this._userToken = undefined;
    this._openID = wechatOpenID;
    this._heartbeatInterval = 55;
}

/**
 * Websocket连接对象构造函数
 * 
 * @class
 * @param {String}   wsInfo   指定Websocket域名信息
 * @param {String}   dataType 指定数据类型(数据点数据attrs_v4 or 自定义数据custom)
 * @param {Function} callback 指定回调对象
 */
function Connection(wsInfo, dataType, callback) {
    this._subscribedDids = [];
    this._dataType = dataType;
    this._loginFailedCount = 0;
    this._websocket = undefined;
    this._callbackObj = callback;
    this._heartbeatTimerID = undefined;
    this._lastConnectMilliTimestamp = 0;
    this._wsUrl = "{0}/ws/app/v1".format(wsInfo);
}

/**
 * 初始化(获取绑定设备列表)
 * 
 * @see 成功回调接口 onInit
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.init = function() {
    this._getUserToken();
}

/**
 * 连接指定设备标识码对应的设备
 * 
 * @param {String} did 指定设备标识码
 * @see 成功回调接口 onConnected
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.connect = function(did) {
    if (!this._boundDevices) {
        this._sendError("Please call 'init()' firstly.");
        return;
    }

    //找到指定设备标识码对应的设备对象
    var device = this._boundDevices[did];
    if (!device) {
        this._sendError("Device is not bound.");
        return;
    }

    //每个设备创建两个Websocket分别用于传输数据点数据跟自定义数据
    this._connect(device, P0_TYPE_ATTRS_V4);
    this._connect(device, P0_TYPE_CUSTOM);
};

/**
 * 读取指定设备标识码对应的设备的状态(对于定义了变长数据点的设备还可以指定关心的数据点名称读取指定的数据点状态)
 * 
 * @param {String}          did       指定设备标识码
 * @param {?Array.<String>} attrNames 指定关心的数据点名称(null或undefined则表示不指定,定义了定长数据点的设备指定该字段无意义)
 * @see 成功回调接口 onReceiveAttrs
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.read = function(did, attrNames) {
    if (!this._boundDevices) {
        this._sendError("Please call 'init()' firstly.");
        return;
    }

    //找到指定设备标识码对应的设备对象
    var device = this._boundDevices[did];
    if (!device) {
        this._sendError("Device is not bound.");
        return;
    }

    //往Websocket连接发送数据点数据读请求
    if (attrNames) {
        this._sendJson(device, P0_TYPE_ATTRS_V4, {
            cmd: "c2s_read",
            data: {
                did: did,
                names: attrNames
            }
        });
    } else {
        this._sendJson(device, P0_TYPE_ATTRS_V4, {
            cmd: "c2s_read",
            data: {
                did: did
            }
        });
    }
};

/**
 * 向指定设备标识码对应的设备发送指定数据点数据或自定义数据
 * 
 * @param {Sring}           did   指定设备标识码
 * @param {?Array.<String>} attrs 指定数据点数据(null或undefined则表示不发送数据点数据)
 * @param {?Array.<Number>} raw   指定自定义数据(null或undefined则表示不发送自定义数据)
 * @see 成功回调接口 onReceiveAttrs && onReceivedRaw(有自定义数据上报时才回调);
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.write = function(did, attrs, raw) {
    if (!this._boundDevices) {
        this._sendError("Please call 'init()' firstly.");
        return;
    }

    //找到指定设备标识码对应的设备对象
    var device = this._boundDevices[did];
    if (!device) {
        this._sendError("Device is not bound.");
        return;
    }

    if (attrs) {
        //往Websocket连接发送数据点数据
        this._sendJson(device, P0_TYPE_ATTRS_V4, {
            cmd: "c2s_write",
            data: {
                did: did,
                attrs: attrs
            }
        });
    }

    if (raw) {
        //往Websocket连接发送自定义数据
        this._sendJson(device, P0_TYPE_CUSTOM, {
            cmd: "c2s_raw",
            data: {
                did: did,
                raw: raw
            }
        });
    }
};

/**
 * 向指定设备标识码对应的设备发送指定透传数据专用接口(后续不再支持,请采用write接口替代)
 * 
 * @param {String}         did  指定设备标识码
 * @param {Array.<Number>} data 指定透传数据
 * @see 成功回调接口 onReceivedAttrs && onReceivedRaw
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.send = function(did, data) {
    if (!this._boundDevices) {
        this._sendError("Please call 'init()' firstly.");
        return;
    }

    //找到指定设备标识码对应的设备对象
    var device = this._boundDevices[did];
    if (!device) {
        this._sendError("Device is not bound.");
        return;
    }

    //往Websocket连接发送自定义数据
    this._sendJson(device, P0_TYPE_CUSTOM, {
        cmd: "c2s_raw",
        data: {
            did: did,
            raw: data
        }
    });
};

/**
 * 更新指定设备标识码对应的中控的子设备列表
 * 
 * @param {String} did  指定设备标识码
 * @see 成功回调接口 onUpdateSubDevices
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.updateSubDevices = function(did) {
    if (!typeof this._boundDevices) {
        this._sendError("Please call 'init()' firstly.");
        return;
    }

    //找到指定设备标识码对应的设备对象
    var device = this._boundDevices[did];
    if (!device) {
        this._sendError("Device is not bound.");
        return;
    }

    //由于长度字段依赖后续字段长度,故先组装长度字段后续字段
    var index = 0;
    var remainData = new Uint8Array(8);
    var remainDataView = new DataView(remainData.buffer);
    remainData[index++] = 0x00; //Flag
    remainData.set([0x00, 0x93], index); //指定透传业务指令0x0093
    index += 2;
    remainDataView.setInt32(index, this._gloabSN++); //指定SN
    index += 4;
    remainData[index++] = 0x5A; //指定获取子设备列表Action

    //组整包
    var data = PROTOCOL_VER.concat(this._getMQTTLenArray(index)).concat(Array.from(remainData.slice(0, index)));

    //往Websocket连接发送自定义数据
    this._sendJson(device, P0_TYPE_CUSTOM, {
        cmd: "c2s_raw",
        data: {
            did: did,
            raw: data
        }
    });
}

/**
 * 向指定设备标识码对应的中控发送添加子设备请求(并可指定待筛选的子设备信息)
 * 
 * @param {String}          did        指定设备标识码
 * @param {?Array.<Object>} subDevices 指定待筛选的子设备信息(null或undefined则表示不指定)
 * @see 成功回调接口 onUpdateSubDevices
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.addSubDevice = function(did, subDevices) {
    if (!this._boundDevices) {
        this._sendError("Please call 'init()' firstly.");
        return;
    }

    //找到指定设备标识码对应的设备对象
    var device = this._boundDevices[did];
    if (!device) {
        this._sendError("Device is not bound.");
        return;
    }

    //由于长度字段依赖后续字段长度,故先组装长度字段后续字段
    var index = 0;
    var remainData = new Uint8Array(128);
    var remainDataView = new DataView(remainData.buffer);
    remainData[index++] = 0; //Flag
    remainData.set([0x00, 0x93], index); //指定透传业务指令0x0093
    index += 2;
    remainDataView.setInt32(index, this._gloabSN++); //指定SN
    index += 4;
    remainData[index++] = 0x56; //指定添加子设备Action
    var subDeviceNum = subDevices ? subDevices.length : 0;
    remainDataView.setInt16(index, subDeviceNum); //指定设备识别码个数
    index += 2;

    //指定设备识别码
    var encoder = new TextEncoder();
    for (var i = 0; i < subDeviceNum; i++) {
        var mac = subDevices[i].mac;
        if (mac) {
            remainData[index++] = mac.length; //设备识别码长度
            remainData.set(encoder.encode(mac), index); //设备识别码
            index += mac.length;
        }
    }

    //组整包
    var data = PROTOCOL_VER.concat(this._getMQTTLenArray(index)).concat(Array.from(remainData.slice(0, index)));

    //往Websocket连接发送自定义数据
    this._sendJson(device, P0_TYPE_CUSTOM, {
        cmd: "c2s_raw",
        data: {
            did: did,
            raw: data
        }
    });
}

/**
 * 向指定设备标识码对应的中控发送删除指定子设备信息对应的子设备请求
 * 
 * @param  {String}           did        指定设备标识码
 * @param  {?Array.<Object>}} subDevices 指定待删除的子设备信息
 * @see 成功回调接口 onUpdateSubDevices
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.deleteSubDevice = function(did, subDevices) {
    if (!subDevices) {
        this._sendError("Please special valid subDevices.");
        return;
    }

    if (!this._boundDevices) {
        this._sendError("Please call 'init()' firstly.");
        return;
    }

    //找到指定设备标识码对应的设备对象
    var device = this._boundDevices[did];
    if (!device) {
        this._sendError("Device is not bound.");
        return;
    }

    //找到指定设备标识码对应的设备对象下的子设备列表
    var subDevicesCache = this._subDevices[did];
    if (!subDevicesCache) {
        this._sendError("Device do not have subDevices be cached.");
        return;
    }

    //挨个删除子设备
    for (var i = 0; i < subDevices.length; i++) {
        var subDeviceCache = subDevicesCache[subDevices[i].did];
        if (subDeviceCache) {
            //匹配到子设备
            //由于长度字段依赖后续字段长度,故先组装长度字段后续字段
            var index = 0;
            var remainData = new Uint8Array(16);
            var remainDataView = new DataView(remainData.buffer);
            remainData[index++] = 0; //Flag
            remainData.set([0x00, 0x93], index); //指定透传业务指令0x0093
            index += 2;
            remainDataView.setInt32(index, this._gloabSN++); //指定SN
            index += 4;
            remainData[index++] = 0x58; //指定删除子设备Action
            remainDataView.setInt32(index, subDeviceCache.subDid); //指定待删除子设备ID
            index += 4;

            //组整包
            var data = PROTOCOL_VER.concat(this._getMQTTLenArray(index)).concat(Array.from(remainData.slice(0, index)));

            //往Websocket连接发送自定义数据
            this._sendJson(device, P0_TYPE_CUSTOM, {
                cmd: "c2s_raw",
                data: {
                    did: did,
                    raw: data
                }
            });
        }
    }
}

/**
 * 绑定指定子设备信息对应的子设备
 *
 * @param  {String} customURL    指定业务服务器
 * @param  {Object} device       指定设备信息
 * @see 成功回调接口 onInit通知绑定设备列表变化
 * @see 失败回调接口 onError
 */
GizwitsWS.prototype.bindDevice = function(customURL, device) {
    if (!device) {
        this._sendError("Please special valid device.");
        return;
    }

    if (!customURL) {
        this._sendError("Please special valid customURL.");
        return;
    }

    var gizWS = this;
    var data = JSON.stringify({
        wechat_openId: gizWS._openID,
        mac: device.mac,
        product_key: device.product_key
    });
    $.ajax(customURL, {
            type: "POST",
            contentType: "application/json",
            dataType: "json",
            data: data
        })
        .done(function(result) {
            var online = false;
            if ('online' === result.netStatus) {
                online = true;
            }
            if (result.did) {
                gizWS._boundDevices[result.did] = {
                    remark: '',
                    dev_alias: '',
                    type: 'sub_dev',
                    did: result.did,
                    mac: result.mac,
                    is_online: online,
                    product_key: result.product_key
                };

                if (gizWS.onInit) {
                    var i = 0;
                    var devices = [];
                    for (var key in gizWS._boundDevices) {
                        devices[i++] = {
                            "did": gizWS._boundDevices[key].did,
                            "mac": gizWS._boundDevices[key].mac,
                            "type": gizWS._boundDevices[key].type,
                            "remark": gizWS._boundDevices[key].remark,
                            "is_online": gizWS._boundDevices[key].is_online,
                            "dev_alias": gizWS._boundDevices[key].dev_alias,
                            "product_key": gizWS._boundDevices[key].product_key
                        };
                    }
                    gizWS.onInit(devices);
                }
            }
        })
        .fail(function(evt) {
            gizWS._sendError("bindSubDevice error: " + evt.responseText);
        });
}

//=========================================================
// http functions
//=========================================================
GizwitsWS.prototype._getUserToken = function() {
    var gizWS = this;
    var url = "https://{0}/app/users".format(gizWS._apiHost);
    $.ajax(url, {
            type: "POST",
            contentType: "application/json",
            headers: { "X-Gizwits-Application-Id": gizWS._appID },
            dataType: "json",
            data: "{\"phone_id\":\"" + gizWS._openID + "\",\"lang\":\"en\"}"
        })
        .done(function(result) {
            gizWS._userID = result.uid;
            gizWS._userToken = result.token;
            gizWS._boundDevices = {};
            gizWS._getBoundDevices(20, 0); //limit 20, skip 0
        })
        .fail(function(evt) {
            gizWS._sendError("Init error when getting user token: " + evt.responseText);
        });
};

GizwitsWS.prototype._getBoundDevices = function(limit, skip) {
    var gizWS = this;
    var url = "https://{0}/app/bindings".format(gizWS._apiHost);
    var query = "?show_disabled=0&limit=" + limit + "&skip=" + skip;

    $.ajax(url + query, {
            type: "GET",
            contentType: "application/json",
            dataType: "json",
            headers: { "X-Gizwits-Application-Id": gizWS._appID, "X-Gizwits-User-token": gizWS._userToken }
        })
        .done(function(result) {
            for (var i = result.devices.length - 1; i >= 0; i--) {
                var device = result.devices[i];
                gizWS._boundDevices[device.did] = device;
            }

            if (result.devices.length === limit) {
                gizWS._getBoundDevices(limit, skip + limit);
            } else {
                if (gizWS.onInit) {
                    var i = 0;
                    var devices = [];
                    for (var key in gizWS._boundDevices) {
                        devices[i++] = {
                            "did": gizWS._boundDevices[key].did,
                            "mac": gizWS._boundDevices[key].mac,
                            "type": gizWS._boundDevices[key].type,
                            "remark": gizWS._boundDevices[key].remark,
                            "is_online": gizWS._boundDevices[key].is_online,
                            "dev_alias": gizWS._boundDevices[key].dev_alias,
                            "product_key": gizWS._boundDevices[key].product_key
                        };
                    }
                    gizWS.onInit(devices);
                }
            }
        })
        .fail(function(evt) {
            gizWS._boundDevices = {};
            gizWS._sendError("getBoundDevices error: " + evt.responseText);
        });
};

//=========================================================
// websocket functions
//=========================================================
Connection.prototype._connectWS = function() {
    var conn = this;

    conn._stopPing();
    var websocket = new WebSocket(conn._wsUrl);
    websocket.onopen = function(evt) { conn._onWSOpen(evt) };
    websocket.onclose = function(evt) { conn._onWSClose(evt) };
    websocket.onmessage = function(evt) { conn._onWSMessage(evt) };
    websocket.onerror = function(evt) { conn._onWSError(evt) };

    conn._websocket = websocket;
};

Connection.prototype._onWSOpen = function(evt) {
    this._login();
};

Connection.prototype._onWSClose = function(evt) {
    this._stopPing();
    this._callbackObj._sendError("Websocket Connect failed, please try again after a moment.");
};

Connection.prototype._onWSMessage = function(evt) {
    var d = new Date();
    var n = d.toLocaleTimeString();
    console.log(n + " <-------------------------");
    console.info(evt);
    var res = JSON.parse(evt.data);
    switch (res.cmd) {
        case "pong":
            break;
        case "login_res":
            if (res.data.success === true) {
                this._loginFailedCount = 0;
                this._startPing();
                this._subscribeDevices();
            } else {
                this._tryLoginAgain();
            }
            break;
        case "subscribe_res":
            var failedDids = res.data.failed;
            var successDids = res.data.success;

            if (P0_TYPE_CUSTOM === this._dataType) {
                if (this._callbackObj.onConnected) {
                    for (var i = successDids.length - 1; i >= 0; i--) {
                        this._callbackObj.onConnected(successDids[i].did);
                    }
                }
                for (var i = failedDids.length - 1; i >= 0; i--) {
                    this._removeSubscribeDid(failedDids[j].did);
                    this._callbackObj._sendError("connect error with did: " + failedDids[j].did + ", please try again.");
                }
            }
            break;
        case "s2c_online_status":
            var device = this._callbackObj._boundDevices[res.data.did];
            if (this._callbackObj.onOnlineStatusChanged && device && P0_TYPE_CUSTOM === this._dataType) {
                this._callbackObj.onOnlineStatusChanged({
                    did: device.did,
                    is_online: res.data.online
                });
            }
            break;
        case "s2c_raw":
            var action = undefined;
            var actionP0 = [];
            var did = res.data.did.substr(0, LEN_DID); //Websocket有BUG,res.data.did类似vPGH2Kew5nbZiUwQKP6qiF/usr57701494432320735193,故需要截取
            var device = this._callbackObj._boundDevices[did];
            if (device) {
                //长度字段所占长度不定
                var addIndex = 0;
                for (var i = 4; i < res.data.raw.length; i++) {
                    if (res.data.raw[i] & 0x80) {
                        ++addIndex;
                    } else {
                        break;
                    }
                }

                if (CMD_TRANS_BUSINESS_RESP === res.data.raw[7 + addIndex]) {
                    action = res.data.raw[12 + addIndex];
                    actionP0 = res.data.raw.slice(13 + addIndex);
                } else {
                    action = res.data.raw[8 + addIndex];
                    actionP0 = res.data.raw.slice(9 + addIndex);
                }

                if (P0_CMD_REPORT_SUBDEVICE_STATUS === action) {
                    this._callbackObj._processSubdeviceOnlineReport(did, actionP0);
                    this._callbackObj._notifySubdevices(did);
                } else if (P0_CMD_GET_SUBDEVICE_LIST_RESP === action || P0_CMD_REPORT_SUBDEVICE_LIST === action) {
                    if (this._callbackObj.onUpdateSubDevices && P0_TYPE_CUSTOM === this._dataType) {
                        this._callbackObj._processSubdevicesReport(did, actionP0);
                        this._callbackObj._notifySubdevices(did);
                    }
                } else if (P0_CMD_ADD_SUBDEVICE_RESP === action) {
                    if (actionP0[0]) {
                        console.log("center control device " + did + " add subDevice failed");
                    } else {
                        console.log("center control device " + did + " add subDevice success");
                    }
                } else if (P0_CMD_DELETE_SUBDEVICE_RESP === action) {
                    if (actionP0[0]) {
                        console.log("center control device " + did + " delete subDevice failed");
                    } else {
                        console.log("center control device " + did + " delete subDevice success");
                    }
                } else {
                    if (this._callbackObj.onReceivedRaw) {
                        this._callbackObj.onReceivedRaw({
                            did: device.did,
                            raw: res.data.raw
                        });
                    }
                }
            }
            break;
        case "s2c_noti":
            var device = this._callbackObj._boundDevices[res.data.did];
            if (this._callbackObj.onReceivedAttrs && device) {
                this._callbackObj.onReceivedAttrs({
                    did: device.did,
                    attrs: res.data.attrs
                });
            }
            break;
        case "s2c_invalid_msg":
            var errorCode = res.data.error_code;
            if (1009 === errorCode) {
                this._tryLoginAgain();
            } else {
                this._callbackObj._sendError("ErrorCode " + errorCode + ": " + res.data.msg);
            }
            break;
    }
};

Connection.prototype._onWSError = function(evt) {
    this._callbackObj._sendError("Websocket on error");
};

Connection.prototype._startPing = function() {
    conn = this;
    var heartbeatInterval = conn._callbackObj._heartbeatInterval * 1000;
    conn._heartbeatTimerID = window.setInterval(function() { conn._sendJson({ cmd: "ping" }) }, heartbeatInterval);
};

Connection.prototype._stopPing = function() {
    window.clearInterval(this._heartbeatTimerID);
};

Connection.prototype._sendJson = function(json) {
    var data = JSON.stringify(json);
    var websocket = this._websocket;
    if (websocket.OPEN === websocket.readyState) {
        websocket.send(data);
        return true;
    } else {
        console.log("[" + Date() + "]Send data error, websocket is not connected.");
        return false;
    }
};

//=========================================================
// helper functions
//=========================================================
Connection.prototype._login = function() {
    var keepalive = this._callbackObj._keepalive;
    var json = {
        cmd: "login_req",
        data: {
            appid: this._callbackObj._appID,
            uid: this._callbackObj._userID,
            token: this._callbackObj._userToken,
            p0_type: this._dataType,
            heartbeat_interval: keepalive, // default 180s
            auto_subscribe: false //按需定阅设备以节省开销
        }
    };
    this._sendJson(json);
};

Connection.prototype._tryLoginAgain = function() {
    var conn = this;
    conn._loginFailedCount += 1;
    if (conn._loginFailedCount > 3) {
        conn._websocket.close();
        return;
    }
    var waitTime = conn._loginFailedCount * RETRY_WAIT_TIME;
    window.setTimeout(function() { conn._login() }, waitTime);
};

Connection.prototype._addSubscribeDid = function(did) {
    var subscribedDids = this._subscribedDids;
    var subFlag = false;
    for (var i = 0; i < subscribedDids.length; i++) {
        if (subscribedDids[i] === did) {
            subFlag = true;
            break;
        }
    }
    if (!subFlag) {
        subscribedDids[subscribedDids.length] = did;
    }
};

Connection.prototype._removeSubscribeDid = function(did) {
    var subDids = this._subscribedDids;
    for (var i = 0; i < subDids.length; i++) {
        if (subDids[i] === did) {
            subDids.splice(i, 1);
            break;
        }
    }
};

Connection.prototype._subscribeDevices = function() {
    var reqData = [];
    for (var i = this._subscribedDids.length - 1; i >= 0; i--) {
        reqData.push({ did: this._subscribedDids[i] });
    }
    var json = {
        cmd: "subscribe_req",
        data: reqData
    };
    this._sendJson(json);
};

GizwitsWS.prototype._sendJson = function(device, dataType, json) {
    //找到设备传输自定义数据的Websocket连接
    var conn = this._connections[this._getConntionsKey(device, dataType)];
    if (!conn) {
        this._sendError("Websocket of " + dataType + " is not connected.");
        return;
    }

    if (!conn._sendJson(json)) {
        if (Date.now() - conn._lastConnectMilliTimestamp > RETRY_WAIT_TIME) {
            console.log("[" + Date() + "]Send data error, try to connect again.");
            //每个设备创建两个Websocket分别用于传输数据点数据跟自定义数据
            this._connect(device, P0_TYPE_ATTRS_V4);
            this._connect(device, P0_TYPE_CUSTOM);
            conn._lastConnectMilliTimestamp = Date.now();
            window.setTimeout(function() { conn._login() }, RETRY_SEND_TIME);
        }
    }
}

GizwitsWS.prototype._connect = function(device, dataType) {
    var key = this._getConntionsKey(device, dataType);
    var conn = this._connections[key];
    if (!conn) {
        var wsInfo = this._getWebsocketConnInfo(device);
        conn = new Connection(wsInfo, dataType, this);
    }
    conn._addSubscribeDid(device.did);
    if (!conn._websocket || conn._websocket.readyState != conn._websocket.OPEN) {
        conn._connectWS();
        this._connections[key] = conn;
    } else {
        conn._subscribeDevices();
    }
}

GizwitsWS.prototype._sendError = function(msg) {
    if (this.onError) {
        this.onError(msg);
    }
};

GizwitsWS.prototype._getWebsocketConnInfo = function(device) {
    var pre = "ws://";
    var host = device.host;
    var port = device.ws_port + '';

    if (device.wss_port) {
        pre = "wss://";
        port = device.wss_port + '';
    }

    return pre + host + ":" + port;
};

GizwitsWS.prototype._getConntionsKey = function(device, dataType) {
    return this._getWebsocketConnInfo(device) + "+" + dataType;
};

GizwitsWS.prototype._getMQTTLenArray = function(len) {
    var digitNum = 0;
    var tmpDigit = Math.ceil(len); //去小数点
    var MQTTLenArray = new Array();

    if (len <= 0) return MQTTLenArray;

    do {
        //左移位运算符>>变相将浮点类型转为整型,效率高于Math.floor且不用区分正负
        if (tmpDigit / 0x80 >> 0) {
            MQTTLenArray[digitNum++] = tmpDigit % 0x80 | 0x80;
        } else {
            MQTTLenArray[digitNum++] = tmpDigit % 0x80;
        }
        tmpDigit = (tmpDigit / 0x80 >> 0);
    } while (tmpDigit);

    return MQTTLenArray;
}

GizwitsWS.prototype._processSubdevicesReport = function(did, raw) {
    this._subDevices[did] = {}; //清空子设备列表缓存
    var index = 0;
    var data = new Uint8Array(raw.length);
    data.set(raw, 0);
    var dataView = new DataView(data.buffer);
    var productNum = dataView.getUint16(index); //得到产品个数
    index += 2;
    for (var i = 0; i < productNum; ++i) {
        var productKey = raw.bin2string(index, LEN_PRODUCT_KEY); //得到产品标识
        index += LEN_PRODUCT_KEY;
        var subDevicesNum = dataView.getUint16(index); //得到该产品标识对应的子设备个数
        index += 2;
        for (var j = 0; j < subDevicesNum; ++j) {
            var subDevice = {};
            subDevice.subDid = dataView.getUint32(index); //得到子设备标识码
            index += 4;
            subDevice.is_online = !!raw[index++]; //得到子设备在线状态
            var lenMAC = raw[index++];
            subDevice.mac = raw.bin2string(index, lenMAC); //得到子设备识别码
            index += lenMAC;
            subDevice.did = raw.bin2string(index, LEN_DID); //得到云端分配的子设备标识码
            index += LEN_DID;
            subDevice.product_key = productKey; //得到子设备产品标识

            this._subDevices[did][subDevice.did] = subDevice;
        }
    }
}

GizwitsWS.prototype._processSubdeviceOnlineReport = function(did, raw) {
    var index = 0;
    var data = new Uint8Array(raw.length);
    data.set(raw, 0);
    var dataView = new DataView(data.buffer);
    var subDid = dataView.getUint32(index); //得子设备标识码
    index += 4;

    //找到匹配的子设备
    for (var key in this._subDevices[did]) {
        if (this._subDevices[did][key].subDid === subDid) {
            this._subDevices[did][key].is_online = !!raw[index];
            break;
        }
    }
}

GizwitsWS.prototype._notifySubdevices = function(did) {
    var i = 0;
    var subDevices = [];
    for (var key in this._subDevices[did]) {
        subDevices[i++] = {
            "did": this._subDevices[did][key].did,
            "mac": this._subDevices[did][key].mac,
            "is_online": this._subDevices[did][key].is_online,
            "product_key": this._subDevices[did][key].product_key
        };
    }
    this.onUpdateSubDevices(did, subDevices);
}

/**
 * 将整型数组从指定偏移位置开始的指定长度内容转换成字符串(例如[0,0,65,66,67,68].bin2string(2, 3)转换成"ABC")
 * 
 * @param  {Number} index 指定偏移位置
 * @param  {Number} len   指定长度
 * @return {String} 格式化之后的字符串
 */
Array.prototype.bin2string = function(index, len) {
    var str = "";

    for (var i = 0; i < len; i++) {
        str += String.fromCharCode(this[index + i]);
    }

    return str;
}

/**
 * 字符串格式化打印函数
 *
 * @return {String} 格式化之后的字符串
 */
String.prototype.format = function() {
    var args = arguments;
    return this.replace(/\{(\d+)\}/g,
        function(m, i) {
            return args[i];
        });
};
