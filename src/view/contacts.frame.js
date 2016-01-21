'use strict';

var Vue = require('vue');

var template = `
<div class="frame" id="contacts">
  <ul>
    <li v-for="contact in contacts">
      {{ payload.wechat._getUserNickName(contact) }}
    </li>
  </ul>
</div>
`;

var Contacts = Vue.extend({
  props: ['payload'],
  template: template,
  computed: {
    contacts: function () {
      return this.payload.wechat.contactList;
    }
  }
});

Vue.component('contacts', Contacts);

module.exports = Contacts;
