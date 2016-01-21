/* eslint no-eval: 0 */
'use strict';

var _ = require('lodash');
var request = require('request-promise');
var qrcode = require('qr-image');
var parseXMLString = require('xml2js').parseString;

var WechatBase = require('./wechat_base');
var consts = require('./consts');
var logger = require('./logger');

module.exports = class WechatClient extends WechatBase {

  constructor() {
    super();

    this.isQQUser = false;
    this.networkHistory = [];

    this.rq = request.defaults({
      jar: true,
      gzip: true,
      forever: true,
      headers: {
        'Referer': 'https://web.wechat.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.48 Safari/537.36',
      },
      transform: this._saveNetworkHistory.bind(this),
    });

    this.deviceID = 'e' + String(Math.random().toFixed(15)).substring(2, 17);
  }

  static get EVENTS() {
    return {
      LOGIN: 'login',
      LOGOUT: 'logout',
      ERROR: 'err',
      CHAT_CHANGE: 'chat_change',
    };
  }

  static getDeviceID() {
    return 'e' + String(Math.random().toFixed(15)).substring(2, 17);
  }

  static getMsgID() {
    return (Date.now() + Math.random().toFixed(3)).replace('.', '');
  }

  _setChat(user) {
    super._setChat(user);
    this.emit(WechatClient.EVENTS.CHAT_CHANGE);
  }

  _saveNetworkHistory(body, response) {
    this.networkHistory.push(response);
    if (this.networkHistory.length > consts.MAX_NETWORK_HISTORY) {
      this.networkHistory.shift();
    }
    return body;
  }

  _parseObjResponse(field) {
    return (body, response) => {
      this._saveNetworkHistory(body, response);

      var window = {};
      if (field) {
        window[field] = {};
      }

      eval(body);
      return field && window[field] || window;
    };
  }

  _parseBaseResponse(body, response) {
    this._saveNetworkHistory(body, response);

    if (!body || !body.BaseResponse) {
      throw `Invalid response.(body=${body})`;
    }

    if (Number.parseInt(body.BaseResponse.Ret, 10) !== 0) {
      throw body.BaseResponse.Ret;
    }
    return body;
  }

  loginQR(uuid) {
    var url = consts.DOMAIN[this.isQQUser].login + consts.URL.LOGIN_QRCODE + uuid;
    return 'data:image/png;base64,' + qrcode.imageSync(url, { type: 'png' }).toString('base64');
  }

  _checkLogin(uuid) {
    logger.info('Waiting for scan...');
    return new Promise((resolve, reject) => {
      var self = this;
      var _tip = 1;
      (function doCheckLogin() {
        var options = {
          uri: consts.DOMAIN[self.isQQUser].login + consts.URL.CHECK_LOGIN,
          qs: {
            _: Date.now(),
            r: ~Date.now(),
            loginicon: false,
            tip: _tip,
            uuid: uuid,
          },
          qsStringifyOptions: {
            encode: false,  // disable encode for '=' in uuid
          },
          transform: self._parseObjResponse().bind(this),
          timeout: consts.TIMEOUT_LONG_PULL,
        };

        self.rq(options).then((resp) => {
          switch (Number.parseInt(resp.code, 10)) {
            case 200:
              return resolve(resp.redirect_uri);
            case 400:
              return reject('UUID expired. Try again please.');
            case 500:
            case 0:
              return reject('Server error. Try again please.');
            case 201:
              logger.info('QRCode is scanned.');
              _tip = 0;
              return doCheckLogin();
            default:
              return doCheckLogin();
          }
        }).catch(doCheckLogin)
        .done();
      })();
    });
  }

  _checkQQUser(url) {
    if (url.match('^https://wx.qq.com')) {
      this.isQQUser = true;
    }

    return url;
  }

  _webwxnewloginpage(url) {
    var options = {
      uri: url,
      qs: { fun: 'new', version: 'v2' },
    };

    return new Promise((resolve, reject) => {
      this.rq(options).then((resp) => {
        parseXMLString(resp, { trim: true, explicitArray: false }, (err, result) => {
          if (err) {
            return reject('Failed to parse login data.');
          }

          var data = result.error;
          if (Number.parseInt(data.ret, 10) !== 0 ||
              !data.skey || !data.wxsid || !data.wxuin || !data.pass_ticket) {
            return reject('Failed to get login data.');
          }

          this._updateLoginData({
            skey: data.skey,
            sid: data.wxsid,
            uin: parseInt(data.wxuin),
            passTicket: data.pass_ticket,
          });

          resolve();
        });
      }).catch((err) => {
        logger.error('Failed to login.');
        reject(err);
      });
    });
  }

  _genBaseRequest(data) {
    return _.extend({
      BaseRequest: {
        Uin: this.loginData.uin,
        Sid: this.loginData.sid,
        SKey: this.loginData.skey,
        DeviceID: WechatClient.deviceID,
      },
    }, data);
  }

  _saveChatHistory(from, to, content) {
    var time = new Date().toLocaleTimeString();
    var msg = {
      time: time,
      from: this._getUserNickName(from),
      to: this._getUserNickName(to),
      message: content,
    };

    var fromUser = this.contacts[from];
    if (fromUser) {
      fromUser.chatHistory = fromUser.chatHistory || [];
      fromUser.chatHistory.push(msg);
      if (fromUser.chatHistory.length > consts.MAX_CHAT_HISTORY) {
        fromUser.chatHistory.shift();
      }
    }

    var toUser = this.contacts[to];
    if (toUser) {
      toUser.chatHistory = toUser.chatHistory || [];
      toUser.chatHistory.push(msg);
      if (toUser.chatHistory.length > consts.MAX_CHAT_HISTORY) {
        toUser.chatHistory.shift();
      }
    }
  }

  _printTextMsg(msg) {
    var time = new Date(msg.CreateTime * 1000).toLocaleTimeString();
    var data = {
      time: time,
      from: this._getUserNickName(msg.FromUserName),
      message: msg.Content,
    };

    if (!WechatClient.isRoomContact(msg.FromUserName)) {
      data.to = this._getUserNickName(msg.ToUserName);
    }

    if (msg.ActualSender) {
      data.From += ' : ' + this._getUserNickName(msg.ActualSender);
    }

    if (!WechatClient.isMuted(this.contacts[msg.PeerUserName])) {
      console.log(columnify([data]));
    }
  }

  _statusNotifyProcess(msg) {
    switch (Number.parseInt(msg.StatusNotifyCode, 10)) {
      case consts.STATUS_NOTIFY_CODE.SYNC_CONV:
        this._initChatList(msg.StatusNotifyUserName);
        break;

      case consts.STATUS_NOTIFY_CODE.ENTER_SESSION:
        this._addChatList([msg]);
        break;

      default:
        break;
    }
  }

  _commonMsgProcess(msg) {
    // parse sender of msg in chat room
    msg.Content = msg.Content.replace(/^(@[a-zA-Z0-9]+|[a-zA-Z0-9_-]+):<br\/>/, (_, sender) => {
      msg.ActualSender = sender;
      return '';
    });

    msg.PeerUserName = this._getMessagePeerUserName(msg);

    return msg;
  }

  _processMediaMessage(msg) {
    if (WechatClient.isMuted(this.contacts[msg.PeerUserName])) {
      return;
    }

    console.log('New message ' +
                `(Peer=${this._getUserNickName(msg.PeerUserName)}, ` +
                  `Type=${msg.msgTypeText})`);

    msg.Content = `[${msg.msgTypeText}]`;
  }

  _messageProcess(msgs) {
    _.each(msgs, (msg) => {
      msg.msgTypeText = _.findKey(consts.MSG_TYPE, _.partial(_.isEqual, msg.MsgType));
      logger.debug(`New message(Type=${msg.msgTypeText})`);

      this._commonMsgProcess(msg);

      switch (Number.parseInt(msg.MsgType, 10)) {
        case consts.MSG_TYPE.TEXT:
          this._printTextMsg(msg);
          break;

        case consts.MSG_TYPE.IMAGE:
        case consts.MSG_TYPE.EMOTICON:
        case consts.MSG_TYPE.VOICE:
          this._processMediaMessage(msg);
          break;

        case consts.MSG_TYPE.STATUS_NOTIFY:
          this._statusNotifyProcess(msg);
          break;

        default:
          break;
      }

      this._saveChatHistory(msg.FromUserName, msg.toUserName, msg.Content);
      this._addChatList([msg]);
    });
  }

  _notifyMobile(type, toUserName) {
    var options = {
      uri: consts.DOMAIN[this.isQQUser].web + consts.URL.NOTIFY_MOBILE,
      method: 'POST',
      json: this._genBaseRequest({
        Code: type,
        FromUserName: this.user.UserName,
        ToUserName: toUserName,
        ClientMsgId: Date.now(),
      }),
    };

    this.rq(options);
  }

  _webwxsync() {
    var options = {
      uri: consts.DOMAIN[this.isQQUser].web + consts.URL.SYNC,
      method: 'POST',
      qs: {
        sid: this.loginData.sid,
        skey: this.loginData.skey,
      },
      json: this._genBaseRequest({
        rr: ~Date.now(),
        SyncKey: this.loginData.syncKey,
      }),
      transform: this._parseBaseResponse.bind(this),
    };

    return new Promise((resolve, reject) => {
      this.rq(options).then((data) => {
        this._updateChatData(data);
        this._messageProcess(data.AddMsgList);
        resolve();
      }).catch(reject).done();
    });
  }

  _batchGetContact(userList) {
    userList = userList || this.contacts;
    var list = _.map(userList, (item) => {
      return {
        UserName: item.UserName || item,
        EncryChatRoomId: item.EncryChatRoomId || '',
      };
    });

    var options = {
      uri: consts.DOMAIN[this.isQQUser].web + consts.URL.BATCH_GET_CONTACT,
      method: 'POST',
      qs: {
        r: Date.now(),
        type: 'ex',
      },
      json: this._genBaseRequest({
        Count: list.length,
        List: list,
      }),
      transform: this._parseBaseResponse.bind(this),
    };

    return new Promise((resolve, reject) => {
      this.rq(options).then((data) => {
        this._addContacts(data.ContactList);
        resolve();
      }).catch(reject).done();
    });
  }

  _synccheck() {
    if (!this.isLogined()) {
      return;
    }

    var options = {
      uri: consts.DOMAIN[this.isQQUser].sync + consts.URL.SYNC_CHECK,
      qs: {
        r: Date.now(),
        skey: this.loginData.skey,
        sid: this.loginData.sid,
        uin: this.loginData.uin,
        deviceid: WechatClient.deviceID,
        synckey: this._getFormateSyncKey(),
        _: Date.now(),
      },
      transform: this._parseObjResponse('synccheck').bind(this),
      timeout: consts.TIMEOUT_LONG_PULL,
    };

    var logout = false;
    this.rq(options).then((resp) => {
      switch (Number.parseInt(resp.retcode, 10)) {
        case 0:
          break;
        case 1100:
          console.log('1100');
          logout = true;
          return this.logout();
        default:
          throw `Sync failed.(ret=${resp.retcode})`;
      }

      if (Number.parseInt(resp.selector, 10) !== 0) {
        this._webwxsync();
      }
    }).catch((err) => {
      logger.error('Sync error: ' + err);
    }).then(() => {
      if (!logout) {
        setTimeout(this._synccheck.bind(this), consts.TIMEOUT_SYNC_CHECK);
      }
    })
    .done();
  }

  _wxgetcontact() {
    var options = {
      uri: consts.DOMAIN[this.isQQUser].web + consts.URL.GET_CONTACT,
      qs: {
        r: Date.now(),
        skey: this.loginData.skey,
        pass_ticket: this.loginData.passTicket,
      },
      transform: this._parseBaseResponse.bind(this),
      json: true,
    };

    return new Promise((resolve, reject) => {
      this.rq(options).then((data) => {
        this._addContacts(data.MemberList);
        resolve();
      }).catch((err) => {
        logger.error('Failed to getContact.');
        reject(err);
      }).done();
    });
  }

  _wxinit() {
    return new Promise((resolve, reject) => {
      var options = {
        uri: consts.DOMAIN[this.isQQUser].web + consts.URL.INIT,
        method: 'POST',
        qs: {
          r: ~Date.now(),
          pass_ticket: this.loginData.passTicket
        },
        headers: {
          'Referer': 'https://web.wechat.com/',
          'Content-Type': 'application/json; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.48 Safari/537.36',
        },
        json: this._genBaseRequest(),
        transform: this._parseBaseResponse.bind(this),
      };

      this.rq(options).then((data) => {
        this._updateLoginData({
          skey: data.SKey,
          syncKey: data.SyncKey,
        });

        this._setUserInfo(data.User);
        this._addContact(data.User);
        this._addContacts(data.ContactList);
        this._initChatList(data.ChatSet);

        this._notifyMobile(consts.STATUS_NOTIFY.INITED);

        return resolve(this.user);
      }).catch((err) => {
        logger.error('Failed to init. Please try again.');
        reject(err);
      }).done();
    });
  }

  _errorHandler(reason) {
    logger.error(reason);
    this.emit(WechatClient.EVENTS.ERROR, reason);
  }

  _getUUID() {
    var options = {
      uri: consts.DOMAIN[this.isQQUser].login + consts.URL.JSLOGIN,
      qs: {
        _: Date.now(),
        appid: consts.WX_APP_ID,
        fun: 'new',
        lang: 'en_US',
      },
      transform: this._parseObjResponse('QRLogin').bind(this),
    };

    return this.rq(options).then((resp) => {
      return resp.uuid;
    });
  }

  login() {
    return this._getUUID()
    .then(this._printLoginQR.bind(this))
    .then(this._checkLogin.bind(this))
    .then(this._checkQQUser.bind(this))
    .then(this._webwxnewloginpage.bind(this))
    .then(this._wxinit.bind(this))
    .then(() => { this.emit(WechatClient.EVENTS.LOGIN, this.user); })
    .then(this._wxgetcontact.bind(this))
    .then(this._synccheck.bind(this))
    .catch(this._errorHandler.bind(this))
    .done();
  }

  logout() {
    return new Promise((resolve, reject) => {
      if (!this.isLogined()) {
        return resolve();
      }

      var options = {
        uri: consts.DOMAIN[this.isQQUser].web + consts.URL.LOGOUT,
        simple: false,
        method: 'POST',
        qs: {
          skey: this.loginData.skey,
          type: 0,
          redirect: 0,
        },
        form: {
          sid: this.loginData.sid,
          uin: this.loginData.uin,
        },
      };

      this.rq(options)
      .finally(() => {
        this._initData();
        this.emit(WechatClient.EVENTS.LOGOUT);
        resolve();
      });
    });
  }

  sendMsg(msg) {
    msg = _.trim(msg);
    if (!msg) {
      return;
    }

    if (!this.chat || !this.chat.UserName) {
      logger.info('Select chat target first.');
      return;
    }

    var msgId = WechatClient.getMsgID();
    var options = {
      uri: consts.DOMAIN[this.isQQUser].web + consts.URL.SEND_MSG,
      method: 'POST',
      qs: { pass_ticket: this.loginData.passTicket },
      json: this._genBaseRequest({
        Msg: {
          Content: msg,
          Type: consts.MSG_TYPE.TEXT,
          FromUserName: this.user.UserName,
          ToUserName: this.chat.UserName,
          ClientMsgId: msgId,
          LocalID: msgId,
        },
      }),
      transform: this._parseBaseResponse.bind(this),
    };

    this.rq(options).then(() => {
      this._saveChatHistory(this.user.UserName, this.chat.UserName, msg);
      logger.debug('Msg sent.');
    }).catch((err) => {
      logger.error('Failed to send message.');
      logger.debug(err);
    });
  }

  listChat(input) {
    if (_.isEmpty(input)) {
      if (_.isEmpty(this.chatList)) {
        console.log('No chat.');
        return;
      }

      console.log(chalk.bold.green('Chats:'));
      _.each(this.chatList, (name, index) => {
        console.log(`#${index} ${this._getUserNickName(name)}`);
      });
      return;
    }

    var index = Number.parseInt(input, 10);
    if (Number.isNaN(index)) {
      logger.error('Enter index of chat please.');
      return;
    }

    var name = index < 0 ? this.user.UserName : this.chatList[index];
    var user = this.contacts[name];
    if (!_.isEmpty(user)) {
      this._setChat(user);
    }
  }

  listContact(input) {
    if (_.isEmpty(input)) {
      console.log(chalk.bold.green('Contacts:'));
      _.each(this.contactList, (user, index) => {
        console.log(`#${index} ${this._getUserNickName(user)}`);
      });
      return;
    }

    var index = Number.parseInt(input, 10);
    if (Number.isNaN(index)) {
      logger.error('Enter index of contact please.');
      return;
    }

    var user = index < 0 ? this.user : this.contactList[index];
    if (!_.isEmpty(user)) {
      this._setChat(user);
    }
  }

  quitChat() {
    this._setChat();
  }

  getUser() {
    return this._getUserNickName(this.user);
  }

  getChat() {
    return this._getUserNickName(this.chat);
  }

  searchContact(input) {
    if (_.isEmpty(input)) {
      return;
    }

    _.each(this.contactList, (user, index) => {
      if (user.RemarkName.match(input) ||
          user.NickName.match(input)) {
        console.log(`#${index} ${this._getUserNickName(user, true)}`);
      }
    });
  }

  listRoom() {
    _.each(this.contactList, (user, index) => {
      if (WechatClient.isRoomContact(user)) {
        console.log(`#${index} ${this._getUserNickName(user)}`);
      }
    });
  }

  listMember(input) {
    var room = this.chat;
    if (!_.isEmpty(input)) {
      var index = Number.parseInt(input, 10);
      if (!Number.isNaN(index)) {
        room = this.contactList[index];
      }
    }

    if (_.isEmpty(room)) {
      return;
    }

    if (!WechatClient.isRoomContact(room)) {
      logger.error(this._getUserNickName(room) + ' is not room chat.');
      return;
    }

    console.log(chalk.bold.green(`Member of ${this._getUserNickName(room)}:`));
    _.each(room.MemberList, (name) => {
      console.log('- ' + this._getUserNickName(name));
    });
  }

  displayNetworkHistory(input) {
    if (_.isEmpty(input)) {
      _.each(this.networkHistory, (item, index) => {
        console.log(`#${index} ${item.request.method} ${item.request.uri.pathname}`);
      });

      return;
    }

    var index = Number.parseInt(input, 10);
    if (Number.isNaN(index) ||
        !_.inRange(index, 0, this.networkHistory.length)) {
      logger.error('Invalid index.');
      return;
    }

    var item = this.networkHistory[index];
    console.log(chalk.bold.green(`Network history (#${index}):`));
    console.log(item.toJSON());
  }

  chatHistory(input) {
    var username;
    if (_.isEmpty(input)) {
      if (_.isEmpty(this.chat)) {
        logger.error('Select target chat first, please.');
        return;
      }
      username = this.chat.UserName;
    } else {
      var index = Number.parseInt(input, 10);
      if (Number.isNaN(index)) {
        logger.error('Invalid index.');
        return;
      }
      username = this.chatList[index];
    }

    var user = this.contacts[username];
    if (_.isEmpty(user)) {
      logger.error('User not found.');
      return;
    }

    console.log(chalk.bold.green(`Chat history with ${this._getUserNickName(user)}:`));
    if (_.isEmpty(user.chatHistory)) {
      console.log('No history yet.');
    } else {
      console.log(columnify(user.chatHistory, {
        columns: ['time', 'from', 'to', 'message'],
        preserveNewLines: true,
      }));
    }
  }

  displayUserInfo(input) {
    var user = this.user;
    if (!_.isEmpty(input)) {
      var index = Number.parseInt(input, 10);
      if (Number.isNaN(index)) {
        logger.error('Invalid index.');
        return;
      }

      user = this.contactList[index];
    }

    if (_.isEmpty(user)) {
      logger.error('User not found.');
      return;
    }

    console.log(chalk.bold.green(`Information of ${this._getUserNickName(user)}:`));
    console.log('NickName: ' + user.NickName);
    console.log('RemarkName: ' + user.RemarkName);
    console.log('Gender: ' + _.findKey(consts.SEX, _.partial(_.isEqual, user.Sex)));
    console.log(`Region: ${user.Province || ''} ${user.City || ''}`);  // FIXME: empty for this.user
    console.log('Signature: ' + user.Signature);
  }
};
