'use strict';

var Vue = require('vue');

var template = `
<div class="frame" id="prompt">
  <button type="button" @click="verify">Login to WeChat</buton>
</div>
`;

var Prompt = Vue.extend({
  template: template,
  methods: {
    verify: function () {
      this.$dispatch('changeFrame', 'verify');
    }
  },
  attached: function () {
    this.$dispatch('getQRCode');
  }
});

Vue.component('prompt', Prompt);

module.exports = Prompt;
