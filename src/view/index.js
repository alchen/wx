'use strict';

const _ = require('lodash');
const Vue = require('vue');
const WechatClient = require('../lib/wechat_client.js');
require('../view/prompt.frame.js');
require('../view/verify.frame.js');
require('../view/contacts.frame.js');

Vue.config.debug = true;
Vue.config.strict = true;

var vue = new Vue({
  el: '#content',
  data: {
    uuid: undefined,
    qrcode: undefined,
    verifyInterval: undefined,
    loggedIn: false,
    stage: 'prompt',
    frames: [
      {
        is: 'prompt',
        payload: {}
      }
    ],
    wechat: new WechatClient()
  },
  events: {
    changeFrame: function (target) {
      this.changeFrame(target);
    },
    getQRCode: function () {
      this.getQRCode();
    },
    checkLogin: function () {
      this.checkLogin();
    }
  },
  methods: {
    changeFrame: function (target) {
      if (target === 'verify') {
        this.frames = [
          {
            is: 'verify',
            payload: {
              uuid: this.uuid,
              qrcode: this.qrcode,
              wechat: this.wechat
            }
          }
        ];
      } else if (target === 'contacts') {
        this.frames = [
          {
            is: 'contacts',
            payload: {
              uuid: this.uuid,
              wechat: this.wechat
            }
          }
        ];
      }
    },
    getQRCode: function () {
      this.wechat._getUUID()
        .then((uuid) => {
          this.uuid = uuid;
          return uuid;
        })
        .then(this.wechat.loginQR.bind(this.wechat))
        .then((qr) => {
          this.qrcode = qr;
          if (this.frames[0].is === 'verify') {
            this.frames[0].payload.uuid = this.uuid;
            this.frames[0].payload.qrcode = this.qrcode;
          }
        });
    },
    checkLogin: function () {
      this.wechat._checkLogin(this.uuid)
        .then(this.wechat._checkQQUser.bind(this.wechat))
        .then(this.wechat._webwxnewloginpage.bind(this.wechat))
        .then(this.wechat._wxinit.bind(this.wechat))
        .then(() => { this.wechat.emit(WechatClient.EVENTS.LOGIN, this.wechat.user); })
        .then(this.wechat._wxgetcontact.bind(this.wechat))
        .then(this.wechat._synccheck.bind(this.wechat))
        .catch((reason) => {
          console.log('Login rejected with: ' + reason);
        });
    }
  },
  compiled: function () {
    var self = this;
    // handle events from wechat client
    this.wechat.on(WechatClient.EVENTS.LOGIN, () => {
      self.changeFrame('contacts');
      self.loggedIn = true;
    });
  }
});

module.exports = vue;
