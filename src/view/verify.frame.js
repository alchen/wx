'use strict';

var Vue = require('vue');

var template = `
<div class="frame" id="verify">
  <div class="spinner" v-if="!payload.qrcode"></div>
  <img :src='payload.qrcode' v-if="payload.qrcode" />
</div>
`;

var Verify = Vue.extend({
  props: ['payload'],
  template: template,
  attached: function () {
    this.$dispatch('checkLogin');
  }
});

Vue.component('verify', Verify);

module.exports = Verify;
