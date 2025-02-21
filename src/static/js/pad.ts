// @ts-nocheck
"use strict";

/**
 * This code is mostly from the old Etherpad. Please help us to comment this code.
 * This helps other people to understand this code better and helps them to improve it.
 * TL;DR COMMENTS ON THIS FILE ARE HIGHLY APPRECIATED
 */

/**
 * Copyright 2009 Google Inc., 2011 Peter 'Pita' Martischka (Primary Technology Ltd)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

let socket;

// These jQuery things should create local references, but for now `require()`
// assigns to the global `$` and augments it with plugins.
require("./vendors/jquery");
require("./vendors/farbtastic");
require("./vendors/gritter");

import html10n from "./vendors/html10n";

import { Cookies } from "./pad_utils";

const chat = require("./chat").chat;
const getCollabClient = require("./collab_client").getCollabClient;
const padconnectionstatus = require("./pad_connectionstatus").padconnectionstatus;
const padcookie = require("./pad_cookie").padcookie;
const padeditbar = require("./pad_editbar").padeditbar;
const padeditor = require("./pad_editor").padeditor;
const padimpexp = require("./pad_impexp").padimpexp;
const padmodals = require("./pad_modals").padmodals;
const padsavedrevs = require("./pad_savedrevs");
const paduserlist = require("./pad_userlist").paduserlist;
import padutils from "./pad_utils";
const colorutils = require("./colorutils").colorutils;
import { randomString } from "./pad_utils";
const socketio = require("./socketio");

const hooks = require("./pluginfw/hooks");

// This array represents all GET-parameters which can be used to change a setting.
//   name:     the parameter-name, eg  `?noColors=true`  =>  `noColors`
//   checkVal: the callback is only executed when
//                * the parameter was supplied and matches checkVal
//                * the parameter was supplied and checkVal is null
//   callback: the function to call when all above succeeds, `val` is the value supplied by the user
const getParameters = [
  {
    name: "noColors",
    checkVal: "true",
    callback: (val) => {
      settings.noColors = true;
      $("#clearAuthorship").hide();
    },
  },
  {
    name: "showControls",
    checkVal: "true",
    callback: (val) => {
      $("#editbar").css("display", "flex");
    },
  },
  {
    name: "showChat",
    checkVal: null,
    callback: (val) => {
      if (val === "false") {
        settings.hideChat = true;
        chat.hide();
        $("#chaticon").hide();
      }
    },
  },
  {
    name: "showLineNumbers",
    checkVal: "false",
    callback: (val) => {
      settings.LineNumbersDisabled = true;
    },
  },
  {
    name: "useMonospaceFont",
    checkVal: "true",
    callback: (val) => {
      settings.useMonospaceFontGlobal = true;
    },
  },
  {
    name: "userName",
    checkVal: null,
    callback: (val) => {
      settings.globalUserName = val;
      clientVars.userName = val;
    },
  },
  {
    name: "userColor",
    checkVal: null,
    callback: (val) => {
      settings.globalUserColor = val;
      clientVars.userColor = val;
    },
  },
  {
    name: "rtl",
    checkVal: "true",
    callback: (val) => {
      settings.rtlIsTrue = true;
    },
  },
  {
    name: "alwaysShowChat",
    checkVal: "true",
    callback: (val) => {
      if (!settings.hideChat) chat.stickToScreen();
    },
  },
  {
    name: "chatAndUsers",
    checkVal: "true",
    callback: (val) => {
      chat.chatAndUsers();
    },
  },
  {
    name: "lang",
    checkVal: null,
    callback: (val) => {
      console.log("Val is", val);
      html10n.localize([val, "en"]);
      Cookies.set("language", val);
    },
  },
];

const getParams = () => {
  // Tries server enforced options first..
  for (const setting of getParameters) {
    let value = clientVars.padOptions[setting.name];
    if (value == null) continue;
    value = value.toString();
    if (value === setting.checkVal || setting.checkVal == null) {
      setting.callback(value);
    }
  }

  // Then URL applied stuff
  const params = getUrlVars();
  for (const setting of getParameters) {
    const value = params.get(setting.name);
    if (value && (value === setting.checkVal || setting.checkVal == null)) {
      setting.callback(value);
    }
  }
};

const getUrlVars = () => new URL(window.location.href).searchParams;

const sendClientReady = (isReconnect) => {
  let padId = document.location.pathname.substring(document.location.pathname.lastIndexOf("/") + 1);
  // unescape necessary due to Safari and Opera interpretation of spaces
  padId = decodeURIComponent(padId);

  if (!isReconnect) {
    const titleArray = document.title.split("|");
    const title = titleArray[titleArray.length - 1];
    document.title = `${padId.replace(/_+/g, " ")} | ${title}`;
  }

  let token = Cookies.get("token");
  if (token == null || !padutils.isValidAuthorToken(token)) {
    token = padutils.generateAuthorToken();
    Cookies.set("token", token, { expires: 60 });
  }

  // If known, propagate the display name and color to the server in the CLIENT_READY message. This
  // allows the server to include the values in its reply CLIENT_VARS message (which avoids
  // initialization race conditions) and in the USER_NEWINFO messages sent to the other users on the
  // pad (which enables them to display a user join notification with the correct name).
  const params = getUrlVars();
  const userInfo = {
    colorId: params.get("userColor"),
    name: params.get("userName"),
  };

  const msg = {
    component: "pad",
    type: "CLIENT_READY",
    padId,
    sessionID: Cookies.get("sessionID"),
    token,
    userInfo,
  };

  // this is a reconnect, lets tell the server our revisionnumber
  if (isReconnect) {
    msg.client_rev = pad.collabClient.getCurrentRevisionNumber();
    msg.reconnect = true;
  }

  socket.emit("message", msg);
};

const handshake = async () => {
  let receivedClientVars = false;
  let padId = document.location.pathname.substring(document.location.pathname.lastIndexOf("/") + 1);
  // unescape necessary due to Safari and Opera interpretation of spaces
  padId = decodeURIComponent(padId);

  // padId is used here for sharding / scaling.  We prefix the padId with padId: so it's clear
  // to the proxy/gateway/whatever that this is a pad connection and should be treated as such
  socket = pad.socket = socketio.connect(exports.baseURL, "/", {
    query: { padId },
    reconnectionAttempts: 5,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.once("connect", () => {
    sendClientReady(false);
  });

  socket.io.on("reconnect", () => {
    // pad.collabClient might be null if the hanshake failed (or it never got that far).
    if (pad.collabClient != null) {
      pad.collabClient.setChannelState("CONNECTED");
    }
    sendClientReady(receivedClientVars);
  });

  const socketReconnecting = () => {
    // pad.collabClient might be null if the hanshake failed (or it never got that far).
    if (pad.collabClient != null) {
      pad.collabClient.setStateIdle();
      pad.collabClient.setIsPendingRevision(true);
      pad.collabClient.setChannelState("RECONNECTING");
    }
  };

  socket.on("disconnect", (reason) => {
    // The socket.io client will automatically try to reconnect for all reasons other than "io
    // server disconnect".
    console.log(`Socket disconnected: ${reason}`);
    //if (reason !== 'io server disconnect' || reason !== 'ping timeout') return;
    socketReconnecting();
  });

  socket.on("shout", (obj) => {
    if (obj.type === "COLLABROOM") {
      let date = new Date(obj.data.payload.timestamp);
      $.gritter.add({
        // (string | mandatory) the heading of the notification
        title: "Admin message",
        // (string | mandatory) the text inside the notification
        text: "[" + date.toLocaleTimeString() + "]: " + obj.data.payload.message.message,
        // (bool | optional) if you want it to fade out on its own or just sit there
        sticky: obj.data.payload.message.sticky,
      });
    }
  });

  socket.io.on("reconnect_attempt", socketReconnecting);

  socket.io.on("reconnect_failed", (error) => {
    // pad.collabClient might be null if the hanshake failed (or it never got that far).
    if (pad.collabClient != null) {
      pad.collabClient.setChannelState("DISCONNECTED", "reconnect_timeout");
    } else {
      throw new Error("Reconnect timed out");
    }
  });

  socket.on("error", (error) => {
    // pad.collabClient might be null if the error occurred before the hanshake completed.
    if (pad.collabClient != null) {
      pad.collabClient.setStateIdle();
      pad.collabClient.setIsPendingRevision(true);
    }
    // Don't throw an exception. Error events do not indicate problems that are not already
    // addressed by reconnection logic, so throwing an exception each time there's a socket.io error
    // just annoys users and fills logs.
  });

  socket.on("message", (obj) => {
    // the access was not granted, give the user a message
    if (obj.accessStatus) {
      if (obj.accessStatus === "deny") {
        $("#loading").hide();
        $("#permissionDenied").show();

        if (receivedClientVars) {
          // got kicked
          $("#editorcontainer").hide();
          $("#editorloadingbox").show();
        }
      }
    } else if (!receivedClientVars && obj.type === "CLIENT_VARS") {
      receivedClientVars = true;
      window.clientVars = obj.data;
      if (window.clientVars.sessionRefreshInterval) {
        const ping = () => $.ajax("../_extendExpressSessionLifetime", { method: "PUT" }).catch(() => {});
        setInterval(ping, window.clientVars.sessionRefreshInterval);
      }
      if (window.clientVars.mode === "development") {
        console.warn("Enabling development mode with live update");
        socket.on("liveupdate", () => {
          console.log("Live reload update received");
          location.reload();
        });
      }
    } else if (obj.disconnect) {
      padconnectionstatus.disconnected(obj.disconnect);
      socket.disconnect();

      // block user from making any change to the pad
      padeditor.disable();
      padeditbar.disable();
      padimpexp.disable();

      return;
    } else {
      pad._messageQ.enqueue(obj);
    }
  });

  await Promise.all([
    new Promise((resolve) => {
      const h = (obj) => {
        if (obj.accessStatus || obj.type !== "CLIENT_VARS") return;
        socket.off("message", h);
        resolve();
      };
      socket.on("message", h);
    }),
    // This hook is only intended to be used by test code. If a plugin would like to use this hook,
    // the hook must first be promoted to officially supported by deleting the leading underscore
    // from the name, adding documentation to `doc/api/hooks_client-side.md`, and deleting this
    // comment.
    hooks.aCallAll("_socketCreated", { socket }),
  ]);
};

/** Defers message handling until setCollabClient() is called with a non-null value. */
class MessageQueue {
  constructor() {
    this._q = [];
    this._cc = null;
  }

  setCollabClient(cc) {
    this._cc = cc;
    this.enqueue(); // Flush.
  }

  enqueue(...msgs) {
    if (this._cc == null) {
      this._q.push(...msgs);
    } else {
      while (this._q.length > 0) this._cc.handleMessageFromServer(this._q.shift());
      for (const msg of msgs) this._cc.handleMessageFromServer(msg);
    }
  }
}

const pad = {
  // don't access these directly from outside this file, except
  // for debugging
  collabClient: null,
  myUserInfo: null,
  diagnosticInfo: {},
  initTime: 0,
  clientTimeOffset: null,
  padOptions: {},
  _messageQ: new MessageQueue(),

  // these don't require init; clientVars should all go through here
  getPadId: () => clientVars.padId,
  getClientIp: () => clientVars.clientIp,
  getColorPalette: () => clientVars.colorPalette,
  getPrivilege: (name) => clientVars.accountPrivs[name],
  getUserId: () => pad.myUserInfo.userId,
  getUserName: () => pad.myUserInfo.name,
  userList: () => paduserlist.users(),
  sendClientMessage: (msg) => {
    pad.collabClient.sendClientMessage(msg);
  },

  init() {
    padutils.setupGlobalExceptionHandler();

    // $(handler), $().ready(handler), $.wait($.ready).then(handler), etc. don't work if handler is
    // an async function for some bizarre reason, so the async function is wrapped in a non-async
    // function.
    $(() =>
      (async () => {
        if (window.customStart != null) window.customStart();
        $("#colorpicker").farbtastic({ callback: "#mycolorpickerpreview", width: 220 });
        $("#readonlyinput").on("click", () => {
          padeditbar.setEmbedLinks();
        });
        padcookie.init();
        await handshake();
        this._afterHandshake();
      })()
    );
  },
  _afterHandshake() {
    pad.clientTimeOffset = Date.now() - clientVars.serverTimestamp;
    // initialize the chat
    chat.init(this);
    getParams();

    padcookie.init(); // initialize the cookies
    pad.initTime = +new Date();
    pad.padOptions = clientVars.initialOptions;

    pad.myUserInfo = {
      userId: clientVars.userId,
      name: clientVars.userName,
      ip: pad.getClientIp(),
      colorId: clientVars.userColor,
    };

    const postAceInit = () => {
      padeditbar.init();
      setTimeout(() => {
        padeditor.ace.focus();
      }, 0);
      const optionsStickyChat = $("#options-stickychat");
      optionsStickyChat.on("click", () => {
        chat.stickToScreen();
      });
      // if we have a cookie for always showing chat then show it
      if (padcookie.getPref("chatAlwaysVisible")) {
        chat.stickToScreen(true); // stick it to the screen
        optionsStickyChat.prop("checked", true); // set the checkbox to on
      }
      // if we have a cookie for always showing chat then show it
      if (padcookie.getPref("chatAndUsers")) {
        chat.chatAndUsers(true); // stick it to the screen
        $("#options-chatandusers").prop("checked", true); // set the checkbox to on
      }
      if (padcookie.getPref("showAuthorshipColors") === false) {
        pad.changeViewOption("showAuthorColors", false);
      }
      if (padcookie.getPref("showLineNumbers") === false) {
        pad.changeViewOption("showLineNumbers", false);
      }
      if (padcookie.getPref("rtlIsTrue") === true) {
        pad.changeViewOption("rtlIsTrue", true);
      }
      pad.changeViewOption("padFontFamily", padcookie.getPref("padFontFamily"));
      $("#viewfontmenu").val(padcookie.getPref("padFontFamily")).niceSelect("update");

      // Prevent sticky chat or chat and users to be checked for mobiles
      const checkChatAndUsersVisibility = (x) => {
        if (x.matches) {
          // If media query matches
          $("#options-chatandusers:checked").trigger("click");
          $("#options-stickychat:checked").trigger("click");
        }
      };
      const mobileMatch = window.matchMedia("(max-width: 800px)");
      mobileMatch.addListener(checkChatAndUsersVisibility); // check if window resized
      setTimeout(() => {
        checkChatAndUsersVisibility(mobileMatch);
      }, 0); // check now after load

      $("#editorcontainer").addClass("initialized");

      hooks.aCallAll("postAceInit", { ace: padeditor.ace, clientVars, pad });
    };

    // order of inits is important here:
    padimpexp.init(this);
    padsavedrevs.init(this);
    padeditor.init(pad.padOptions.view || {}, this).then(postAceInit);
    paduserlist.init(pad.myUserInfo, this);
    padconnectionstatus.init();
    padmodals.init(this);

    pad.collabClient = getCollabClient(padeditor.ace, clientVars.collab_client_vars, pad.myUserInfo, { colorPalette: pad.getColorPalette() }, pad);
    this._messageQ.setCollabClient(this.collabClient);
    pad.collabClient.setOnUserJoin(pad.handleUserJoin);
    pad.collabClient.setOnUpdateUserInfo(pad.handleUserUpdate);
    pad.collabClient.setOnUserLeave(pad.handleUserLeave);
    pad.collabClient.setOnClientMessage(pad.handleClientMessage);
    pad.collabClient.setOnChannelStateChange(pad.handleChannelStateChange);
    pad.collabClient.setOnInternalAction(pad.handleCollabAction);

    // load initial chat-messages
    if (clientVars.chatHead !== -1) {
      const chatHead = clientVars.chatHead;
      const start = Math.max(chatHead - 100, 0);
      pad.collabClient.sendMessage({ type: "GET_CHAT_MESSAGES", start, end: chatHead });
    } else {
      // there are no messages
      $("#chatloadmessagesbutton").css("display", "none");
    }

    if (window.clientVars.readonly) {
      chat.hide();
      $("#myusernameedit").attr("disabled", true);
      $("#chatinput").attr("disabled", true);
      $("#chaticon").hide();
      $("#options-chatandusers").parent().hide();
      $("#options-stickychat").parent().hide();
    } else if (!settings.hideChat) {
      $("#chaticon").show();
    }

    $("body").addClass(window.clientVars.readonly ? "readonly" : "readwrite");

    padeditor.ace.callWithAce((ace) => {
      ace.ace_setEditable(!window.clientVars.readonly);
    });

    // If the LineNumbersDisabled value is set to true then we need to hide the Line Numbers
    if (settings.LineNumbersDisabled === true) {
      this.changeViewOption("showLineNumbers", false);
    }

    // If the noColors value is set to true then we need to
    // hide the background colors on the ace spans
    if (settings.noColors === true) {
      this.changeViewOption("noColors", true);
    }

    if (settings.rtlIsTrue === true) {
      this.changeViewOption("rtlIsTrue", true);
    }

    // If the Monospacefont value is set to true then change it to monospace.
    if (settings.useMonospaceFontGlobal === true) {
      this.changeViewOption("padFontFamily", "RobotoMono");
    }
    // if the globalUserName value is set we need to tell the server and
    // the client about the new authorname
    if (settings.globalUserName !== false) {
      this.notifyChangeName(settings.globalUserName); // Notifies the server
      this.myUserInfo.name = settings.globalUserName;
      $("#myusernameedit").val(settings.globalUserName); // Updates the current users UI
    }
    if (settings.globalUserColor !== false && colorutils.isCssHex(settings.globalUserColor)) {
      // Add a 'globalUserColor' property to myUserInfo,
      // so collabClient knows we have a query parameter.
      this.myUserInfo.globalUserColor = settings.globalUserColor;
      this.notifyChangeColor(settings.globalUserColor); // Updates this.myUserInfo.colorId
      paduserlist.setMyUserInfo(this.myUserInfo);
    }
  },

  dispose: () => {
    padeditor.dispose();
  },
  notifyChangeName: (newName) => {
    pad.myUserInfo.name = newName;
    pad.collabClient.updateUserInfo(pad.myUserInfo);
  },
  notifyChangeColor: (newColorId) => {
    pad.myUserInfo.colorId = newColorId;
    pad.collabClient.updateUserInfo(pad.myUserInfo);
  },
  changePadOption: (key, value) => {
    const options = {};
    options[key] = value;
    pad.handleOptionsChange(options);
    pad.collabClient.sendClientMessage({
      type: "padoptions",
      options,
      changedBy: pad.myUserInfo.name || "unnamed",
    });
  },
  changeViewOption: (key, value) => {
    const options = {
      view: {},
    };
    options.view[key] = value;
    pad.handleOptionsChange(options);
  },
  handleOptionsChange: (opts) => {
    // opts object is a full set of options or just
    // some options to change
    if (opts.view) {
      if (!pad.padOptions.view) {
        pad.padOptions.view = {};
      }
      for (const [k, v] of Object.entries(opts.view)) {
        pad.padOptions.view[k] = v;
        padcookie.setPref(k, v);
      }
      padeditor.setViewOptions(pad.padOptions.view);
    }
  },
  // caller shouldn't mutate the object
  getPadOptions: () => pad.padOptions,
  suggestUserName: (userId, name) => {
    pad.collabClient.sendClientMessage({
      type: "suggestUserName",
      unnamedId: userId,
      newName: name,
    });
  },
  handleUserJoin: (userInfo) => {
    paduserlist.userJoinOrUpdate(userInfo);
  },
  handleUserUpdate: (userInfo) => {
    paduserlist.userJoinOrUpdate(userInfo);
  },
  handleUserLeave: (userInfo) => {
    paduserlist.userLeave(userInfo);
  },
  handleClientMessage: (msg) => {
    if (msg.type === "suggestUserName") {
      if (msg.unnamedId === pad.myUserInfo.userId && msg.newName && !pad.myUserInfo.name) {
        pad.notifyChangeName(msg.newName);
        paduserlist.setMyUserInfo(pad.myUserInfo);
      }
    } else if (msg.type === "newRevisionList") {
      padsavedrevs.newRevisionList(msg.revisionList);
    } else if (msg.type === "revisionLabel") {
      padsavedrevs.newRevisionList(msg.revisionList);
    } else if (msg.type === "padoptions") {
      const opts = msg.options;
      pad.handleOptionsChange(opts);
    }
  },
  handleChannelStateChange: (newState, message) => {
    const oldFullyConnected = !!padconnectionstatus.isFullyConnected();
    const wasConnecting = padconnectionstatus.getStatus().what === "connecting";
    if (newState === "CONNECTED") {
      padeditor.enable();
      padeditbar.enable();
      padimpexp.enable();
      padconnectionstatus.connected();
    } else if (newState === "RECONNECTING") {
      padeditor.disable();
      padeditbar.disable();
      padimpexp.disable();
      padconnectionstatus.reconnecting();
    } else if (newState === "DISCONNECTED") {
      pad.diagnosticInfo.disconnectedMessage = message;
      pad.diagnosticInfo.padId = pad.getPadId();
      pad.diagnosticInfo.socket = {};

      // we filter non objects from the socket object and put them in the diagnosticInfo
      // this ensures we have no cyclic data - this allows us to stringify the data
      for (const [i, value] of Object.entries(socket.socket || {})) {
        const type = typeof value;

        if (type === "string" || type === "number") {
          pad.diagnosticInfo.socket[i] = value;
        }
      }

      pad.asyncSendDiagnosticInfo();
      if (typeof window.ajlog === "string") {
        window.ajlog += `Disconnected: ${message}\n`;
      }
      padeditor.disable();
      padeditbar.disable();
      padimpexp.disable();

      padconnectionstatus.disconnected(message);
    }
    const newFullyConnected = !!padconnectionstatus.isFullyConnected();
    if (newFullyConnected !== oldFullyConnected) {
      pad.handleIsFullyConnected(newFullyConnected, wasConnecting);
    }
  },
  handleIsFullyConnected: (isConnected, isInitialConnect) => {
    pad.determineChatVisibility(isConnected && !isInitialConnect);
    pad.determineChatAndUsersVisibility(isConnected && !isInitialConnect);
    pad.determineAuthorshipColorsVisibility();
    setTimeout(() => {
      padeditbar.toggleDropDown("none");
    }, 1000);
  },
  determineChatVisibility: (asNowConnectedFeedback) => {
    const chatVisCookie = padcookie.getPref("chatAlwaysVisible");
    if (chatVisCookie) {
      // if the cookie is set for chat always visible
      chat.stickToScreen(true); // stick it to the screen
      $("#options-stickychat").prop("checked", true); // set the checkbox to on
    } else {
      $("#options-stickychat").prop("checked", false); // set the checkbox for off
    }
  },
  determineChatAndUsersVisibility: (asNowConnectedFeedback) => {
    const chatAUVisCookie = padcookie.getPref("chatAndUsersVisible");
    if (chatAUVisCookie) {
      // if the cookie is set for chat always visible
      chat.chatAndUsers(true); // stick it to the screen
      $("#options-chatandusers").prop("checked", true); // set the checkbox to on
    } else {
      $("#options-chatandusers").prop("checked", false); // set the checkbox for off
    }
  },
  determineAuthorshipColorsVisibility: () => {
    const authColCookie = padcookie.getPref("showAuthorshipColors");
    if (authColCookie) {
      pad.changeViewOption("showAuthorColors", true);
      $("#options-colorscheck").prop("checked", true);
    } else {
      $("#options-colorscheck").prop("checked", false);
    }
  },
  handleCollabAction: (action) => {
    if (action === "commitPerformed") {
      padeditbar.setSyncStatus("syncing");
    } else if (action === "newlyIdle") {
      padeditbar.setSyncStatus("done");
    }
  },
  asyncSendDiagnosticInfo: () => {
    window.setTimeout(() => {
      $.ajax({
        type: "post",
        url: "../ep/pad/connection-diagnostic-info",
        data: {
          diagnosticInfo: JSON.stringify(pad.diagnosticInfo),
        },
        success: () => {},
        error: () => {},
      });
    }, 0);
  },
  forceReconnect: () => {
    $("form#reconnectform input.padId").val(pad.getPadId());
    pad.diagnosticInfo.collabDiagnosticInfo = pad.collabClient.getDiagnosticInfo();
    $("form#reconnectform input.diagnosticInfo").val(JSON.stringify(pad.diagnosticInfo));
    $("form#reconnectform input.missedChanges").val(JSON.stringify(pad.collabClient.getMissedChanges()));
    $("form#reconnectform").trigger("submit");
  },
  callWhenNotCommitting: (f) => {
    pad.collabClient.callWhenNotCommitting(f);
  },
  getCollabRevisionNumber: () => pad.collabClient.getCurrentRevisionNumber(),
  isFullyConnected: () => padconnectionstatus.isFullyConnected(),
  addHistoricalAuthors: (data) => {
    if (!pad.collabClient) {
      window.setTimeout(() => {
        pad.addHistoricalAuthors(data);
      }, 1000);
    } else {
      pad.collabClient.addHistoricalAuthors(data);
    }
  },
};

const init = () => pad.init();

const settings = {
  LineNumbersDisabled: false,
  noColors: false,
  useMonospaceFontGlobal: false,
  globalUserName: false,
  globalUserColor: false,
  rtlIsTrue: false,
};

pad.settings = settings;

exports.baseURL = "";
exports.settings = settings;
exports.randomString = randomString;
exports.getParams = getParams;
exports.pad = pad;
exports.init = init;

// document.addEventListener("DOMContentLoaded", function () {
//   const generateButton = document.getElementById("generate-mindmap");
//   const modal = document.getElementById("mindmap-modal");
//   const closeModalButton = document.getElementById("close-modal");

//   if (!generateButton || !modal) {
//     console.error("Generate button or modal not found.");
//     return;
//   }

//   // Close Modal
//   closeModalButton.addEventListener("click", function () {
//     modal.style.display = "none";
//     console.log("Modal closed.");
//   });

//   // Initialize when Generate Button is Clicked
//   generateButton.addEventListener("click", function () {
//     modal.style.display = "flex";
//     console.log("Mind map generation started.");

//     const neo4j = require("neo4j-driver");

//     // Initialize Neo4j Driver
//     const driver = neo4j.driver(
//       "neo4j+s://7b2adf95.databases.neo4j.io",
//       neo4j.auth.basic("neo4j", "INGaFxLI5FZnILVRQY6sG1ZOxtwzexRAXoCI2aeZ3UM")
//     );

//     const session = driver.session();

//     const mindmapContainer = document.getElementById("mindmap-container");
//     const addNodeButton = document.getElementById("add-node");
//     const clearMapButton = document.getElementById("clear-map");
//     const resetMapButton = document.getElementById("reset-map");

//     if (!mindmapContainer) {
//       console.error("Mindmap container not found.");
//       return;
//     }

//     // SVG and Canvas Setup
//     const width = mindmapContainer.clientWidth || 800; // Default size if container size is 0
//     const height = mindmapContainer.clientHeight || 600;

//     const svg = d3
//       .select("#mindmap-container")
//       .append("svg")
//       .attr("width", width)
//       .attr("height", height)
//       .style("cursor", "pointer");

//     const nodes = [];
//     let links = [];
//     let firstNode = null; // For linking two nodes

//     const simulation = d3
//       .forceSimulation(nodes)
//       .force("charge", d3.forceManyBody().strength(-200))
//       .force("link", d3.forceLink(links).distance(100))
//       .force("center", d3.forceCenter(width / 2, height / 2))
//       .on("tick", ticked);

//     const link = svg.append("g").attr("class", "links").selectAll("line");
//     const node = svg.append("g").attr("class", "nodes").selectAll("g");

//     // Fetch Nodes and Links from Neo4j
//     async function fetchFromDatabase() {
//       try {
//         const result = await session.run("MATCH (n)-[r]->(m) RETURN n, r, m");
//         result.records.forEach(record => {
//           const source = record.get("n").properties;
//           const target = record.get("m").properties;
//           const relationship = record.get("r").type;

//           // Add nodes if not already in the array
//           if (!nodes.some(node => node.id === source.id)) {
//             nodes.push({ id: source.id, text: source.text });
//           }
//           if (!nodes.some(node => node.id === target.id)) {
//             nodes.push({ id: target.id, text: target.text });
//           }

//           // Add link
//           links.push({ source, target, type: relationship });
//         });

//         update();
//       } catch (error) {
//         console.error("Error fetching data from Neo4j:", error);
//       }
//     }

//     fetchFromDatabase();

//     // Drag Functions
//     function dragstarted(event, d) {
//       if (!event.active) simulation.alphaTarget(0.3).restart(); // Restart simulation
//       d.fx = d.x; // Fix x-position
//       d.fy = d.y; // Fix y-position
//     }

//     function dragged(event, d) {
//       d.fx = event.x; // Update x-position
//       d.fy = event.y; // Update y-position
//     }

//     function dragended(event, d) {
//       if (!event.active) simulation.alphaTarget(0); // Stop simulation
//       d.fx = null; // Release fixed x-position
//       d.fy = null; // Release fixed y-position
//     }

//     // Update Visualization
//     function update() {
//       console.log("Updating nodes and links...");

//       link.data(links)
//         .join("line")
//         .attr("stroke", "#999")
//         .attr("stroke-width", 2);

//       const newNode = node
//         .data(nodes, d => d.id) // Use id to uniquely identify nodes
//         .join("g")
//         .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended));

//       newNode
//         .append("circle")
//         .attr("r", 30)
//         .attr("fill", "#69b3a2")
//         .attr("stroke", "#333")
//         .attr("stroke-width", 2);

//       newNode
//         .append("text")
//         .attr("dx", -10)
//         .attr("dy", 5)
//         .text(d => d.text || "Node");

//       simulation.alpha(1).restart();
//       console.log("Nodes:", nodes);
//       console.log("Links:", links);
//     }

//      function ticked() {
//       link
//         .attr("x1", d => d.source.x)
//         .attr("y1", d => d.source.y)
//         .attr("x2", d => d.target.x)
//         .attr("y2", d => d.target.y);

//         node.attr("transform", d => `translate(${d.x},${d.y})`);
//       }
//   });
// });

// document.addEventListener("DOMContentLoaded", function () {
//   const generateButton = document.getElementById("generate-mindmap");
//   const modal = document.getElementById("mindmap-modal");
//   const closeModalButton = document.getElementById("close-modal");

//   if (!generateButton || !modal) {
//     console.error("Generate button or modal not found.");
//     return;
//   }

//   // Close Modal
//   closeModalButton.addEventListener("click", function () {
//     modal.style.display = "none";
//     console.log("Modal closed.");
//   });

//   // Initialize when Generate Button is Clicked
//   generateButton.addEventListener("click", function () {
//     modal.style.display = "flex";
//     console.log("Mind map generation started.");

//     const neo4j = require("neo4j-driver");

//     // Initialize Neo4j Driver
//     const driver = neo4j.driver(
//       "neo4j+s://7b2adf95.databases.neo4j.io",
//       neo4j.auth.basic("neo4j", "INGaFxLI5FZnILVRQY6sG1ZOxtwzexRAXoCI2aeZ3UM")
//     );

//     const session = driver.session();

//     const mindmapContainer = document.getElementById("mindmap-container");

//     if (!mindmapContainer) {
//       console.error("Mindmap container not found.");
//       return;
//     }

//     // Clear previous visualization (if any)
//     d3.select("#mindmap-container svg").remove();

//     // SVG and Canvas Setup
//     const width = mindmapContainer.clientWidth || 800;
//     const height = mindmapContainer.clientHeight || 600;

//     const svg = d3
//       .select("#mindmap-container")
//       .append("svg")
//       .attr("width", width)
//       .attr("height", height)
//       .style("cursor", "pointer");

//     let nodes = [];
//     let links = [];

//     const linkGroup = svg.append("g").attr("class", "links");
//     const nodeGroup = svg.append("g").attr("class", "nodes");

//     const simulation = d3
//       .forceSimulation(nodes)
//       .force("link", d3.forceLink(links).id((d) => d.id).distance(100))
//       .force("charge", d3.forceManyBody().strength(-200))
//       .force("center", d3.forceCenter(width / 2, height / 2))
//       .on("tick", ticked);

//     async function fetchFromDatabase() {
//       try {
//         const result = await session.run("MATCH (n)-[r]->(m) RETURN n, r, m");

//         // Clear previous data
//         nodes = [];
//         links = [];

//         result.records.forEach((record) => {
//           const source = record.get("n").properties;
//           const target = record.get("m").properties;
//           const relationship = record.get("r").type;

//           // Add nodes if not already in the array
//           if (!nodes.some((node) => node.id === source.name)) {
//             nodes.push({
//               id: source.name,
//               text: source.name,
//               x: Math.random() * width,
//               y: Math.random() * height,
//             });
//           }
//           if (!nodes.some((node) => node.id === target.name)) {
//             nodes.push({
//               id: target.name,
//               text: target.name,
//               x: Math.random() * width,
//               y: Math.random() * height,
//             });
//           }

//           // Resolve source and target as actual nodes
//           const sourceNode = nodes.find((node) => node.id === source.name);
//           const targetNode = nodes.find((node) => node.id === target.name);

//           if (sourceNode && targetNode) {
//             links.push({
//               source: sourceNode,
//               target: targetNode,
//               type: relationship,
//             });
//           }
//         });

//         update();
//       } catch (error) {
//         console.error("Error fetching data from Neo4j:", error);
//       }
//     }

//     fetchFromDatabase();

//     function update() {
//       console.log("Updating visualization...");

//       // Update Links
//       const link = linkGroup
//         .selectAll("line")
//         .data(links, (d) => `${d.source.id}-${d.target.id}`)
//         .join(
//           (enter) => enter.append("line").attr("stroke", "#999").attr("stroke-width", 2),
//           (update) => update,
//           (exit) => exit.remove()
//         );

//       // Update Nodes
//       const node = nodeGroup
//         .selectAll("g")
//         .data(nodes, (d) => d.id)
//         .join(
//           (enter) => {
//             const nodeEnter = enter
//               .append("g")
//               .call(
//                 d3.drag()
//                   .on("start", dragstarted)
//                   .on("drag", dragged)
//                   .on("end", dragended)
//               );

//             nodeEnter
//               .append("circle")
//               .attr("r", 30)
//               .attr("fill", "#69b3a2")
//               .attr("stroke", "#333")
//               .attr("stroke-width", 2);

//             nodeEnter
//               .append("text")
//               .attr("dx", -10)
//               .attr("dy", 5)
//               .text((d) => d.text || "Node");

//             return nodeEnter;
//           },
//           (update) => update,
//           (exit) => exit.remove()
//         );

//       // Restart simulation
//       simulation.nodes(nodes);
//       simulation.force("link").links(links);
//       simulation.alpha(1).restart();

//       console.log("Nodes:", nodes);
//       console.log("Links:", links);
//     }

//     function ticked() {
//       linkGroup
//         .selectAll("line")
//         .attr("x1", (d) => d.source.x)
//         .attr("y1", (d) => d.source.y)
//         .attr("x2", (d) => d.target.x)
//         .attr("y2", (d) => d.target.y);

//       nodeGroup.selectAll("g").attr("transform", (d) => `translate(${d.x},${d.y})`);
//     }

//     function dragstarted(event, d) {
//       if (!event.active) simulation.alphaTarget(0.3).restart();
//       d.fx = d.x;
//       d.fy = d.y;
//     }

//     function dragged(event, d) {
//       d.fx = event.x;
//       d.fy = event.y;
//     }

//     function dragended(event, d) {
//       if (!event.active) simulation.alphaTarget(0);
//       d.fx = null;
//       d.fy = null;
//     }
//   });
// });

// document.addEventListener("DOMContentLoaded", function () {
//   const generateButton = document.getElementById("generate-mindmap");
//   const modal = document.getElementById("mindmap-modal");
//   const closeModalButton = document.getElementById("close-modal");

//   if (!generateButton || !modal) {
//     console.error("Generate button or modal not found.");
//     return;
//   }

//   // Close Modal
//   closeModalButton.addEventListener("click", function () {
//     modal.style.display = "none";
//     console.log("Modal closed.");
//   });

//   // Initialize when Generate Button is Clicked
//   generateButton.addEventListener("click", function () {
//     modal.style.display = "flex";
//     console.log("Mind map generation started.");

//     const neo4j = require("neo4j-driver");

//     // Initialize Neo4j Driver
//     const driver = neo4j.driver(
//       "neo4j+s://7b2adf95.databases.neo4j.io",
//       neo4j.auth.basic("neo4j", "INGaFxLI5FZnILVRQY6sG1ZOxtwzexRAXoCI2aeZ3UM")
//     );

//     const session = driver.session();

//     const mindmapContainer = document.getElementById("mindmap-container");

//     if (!mindmapContainer) {
//       console.error("Mindmap container not found.");
//       return;
//     }

//     // Clear previous visualization (if any)
//     d3.select("#mindmap-container svg").remove();

//     // SVG and Canvas Setup
//     const width = mindmapContainer.clientWidth || 800;
//     const height = mindmapContainer.clientHeight || 600;

//     const svg = d3
//       .select("#mindmap-container")
//       .append("svg")
//       .attr("width", width)
//       .attr("height", height)
//       .style("cursor", "pointer");

//     let nodes = [];
//     let links = [];

//     const linkGroup = svg.append("g").attr("class", "links");
//     const nodeGroup = svg.append("g").attr("class", "nodes");

//     const simulation = d3
//       .forceSimulation(nodes)
//       .force("link", d3.forceLink(links).id((d) => d.id).distance(100))
//       .force("charge", d3.forceManyBody().strength(-200))
//       .force("center", d3.forceCenter(width / 2, height / 2))
//       .on("tick", ticked);

//     async function fetchFromDatabase() {
//       try {
//         const result = await session.run("MATCH (n)-[r]->(m) RETURN n, r, m");

//         // Clear previous data
//         nodes = [];
//         links = [];

//         result.records.forEach((record) => {
//           const source = record.get("n").properties;
//           const target = record.get("m").properties;
//           const relationship = record.get("r").type;

//           // Add nodes if not already in the array
//           if (!nodes.some((node) => node.id === source.name)) {
//             nodes.push({
//               id: source.name,
//               text: source.name,
//               x: Math.random() * width,
//               y: Math.random() * height,
//             });
//           }
//           if (!nodes.some((node) => node.id === target.name)) {
//             nodes.push({
//               id: target.name,
//               text: target.name,
//               x: Math.random() * width,
//               y: Math.random() * height,
//             });
//           }

//           // Resolve source and target as actual nodes
//           const sourceNode = nodes.find((node) => node.id === source.name);
//           const targetNode = nodes.find((node) => node.id === target.name);

//           if (sourceNode && targetNode) {
//             links.push({
//               source: sourceNode,
//               target: targetNode,
//               type: relationship,
//             });
//           }
//         });

//         update();
//       } catch (error) {
//         console.error("Error fetching data from Neo4j:", error);
//       }
//     }

//     fetchFromDatabase();

//     function update() {
//       console.log("Updating visualization...");

//       // Update Links
//       const link = linkGroup
//         .selectAll("line")
//         .data(links, (d) => `${d.source.id}-${d.target.id}`)
//         .join(
//           (enter) => enter.append("line").attr("stroke", "#999").attr("stroke-width", 2),
//           (update) => update,
//           (exit) => exit.remove()
//         );

//       // Update Nodes
//       const node = nodeGroup
//         .selectAll("g")
//         .data(nodes, (d) => d.id)
//         .join(
//           (enter) => {
//             const nodeEnter = enter
//               .append("g")
//               .call(
//                 d3.drag()
//                   .on("start", dragstarted)
//                   .on("drag", dragged)
//                   .on("end", dragended)
//               );

//             nodeEnter
//               .append("circle")
//               .attr("r", 30)
//               .attr("fill", "#69b3a2")
//               .attr("stroke", "#333")
//               .attr("stroke-width", 2);

//             nodeEnter
//               .append("text")
//               .attr("dx", -10)
//               .attr("dy", 5)
//               .text((d) => d.text || "Node");

//             return nodeEnter;
//           },
//           (update) => update,
//           (exit) => exit.remove()
//         );

//       // Restart simulation
//       simulation.nodes(nodes);
//       simulation.force("link").links(links);
//       simulation.alpha(1).restart();

//       console.log("Nodes:", nodes);
//       console.log("Links:", links);
//     }

//     function ticked() {
//       linkGroup
//         .selectAll("line")
//         .attr("x1", (d) => d.source.x)
//         .attr("y1", (d) => d.source.y)
//         .attr("x2", (d) => d.target.x)
//         .attr("y2", (d) => d.target.y);

//       nodeGroup
//         .selectAll("g")
//         .attr("transform", (d) => `translate(${d.x},${d.y})`);
//     }

//     function dragstarted(event, d) {
//       if (!event.active) simulation.alphaTarget(0.3).restart();
//       d.fx = d.x;
//       d.fy = d.y;
//     }

//     function dragged(event, d) {
//       d.fx = event.x;
//       d.fy = event.y;
//     }

//     function dragended(event, d) {
//       if (!event.active) simulation.alphaTarget(0);
//       d.fx = null;
//       d.fy = null;
//     }
//   });
// });

// document.addEventListener("DOMContentLoaded", function () {
//   const generateButton = document.getElementById("generate-mindmap");
//   const downloadButton = document.getElementById("download-map");
//   const modal = document.getElementById("mindmap-modal");
//   const closeModalButton = document.getElementById("close-modal");
//   const addNode = document.getElementById("add-node");
//   const addRelation = document.getElementById("add-relation");

//   if (!generateButton || !modal || !downloadButton) {
//     console.error("Required elements not found.");
//     return;
//   }

//   window.addEventListener("beforeunload", () => {
//     session.close();
//     driver.close();
//   });

//   // Close Modal
//   closeModalButton.addEventListener("click", function () {
//     modal.style.display = "none";
//     console.log("Modal closed.");
//   });

//   // Function to download the mind map as an image
//   downloadButton.addEventListener("click", function () {
//     const svgElement = document.querySelector("#graph-visualization svg");

//     if (!svgElement) {
//       console.error("SVG element not found.");
//       return;
//     }

//     // Temporarily adjust SVG size to fit all nodes and links
//     const bbox = svgElement.getBBox();
//     const originalWidth = svgElement.getAttribute("width");
//     const originalHeight = svgElement.getAttribute("height");

//     svgElement.setAttribute("width", bbox.width);
//     svgElement.setAttribute("height", bbox.height);
//     svgElement.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);

//     // Convert SVG to data URL
//     const svgData = new XMLSerializer().serializeToString(svgElement);
//     const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
//     const url = URL.createObjectURL(svgBlob);

//     // Create an image to render the SVG
//     const image = new Image();
//     image.onload = () => {
//       const scale = 3; // Increase this value for higher quality
//       const canvas = document.createElement("canvas");
//       canvas.width = bbox.width * scale;
//       canvas.height = bbox.height * scale;

//       const ctx = canvas.getContext("2d");
//       ctx.fillStyle = "white"; // Optional: Set background color
//       ctx.fillRect(0, 0, canvas.width, canvas.height);

//       // Scale the context to render a higher resolution
//       ctx.scale(scale, scale);
//       ctx.drawImage(image, 0, 0);

//       // Trigger download of PNG
//       canvas.toBlob((blob) => {
//         const link = document.createElement("a");
//         link.href = URL.createObjectURL(blob);
//         link.download = "mindmap.png";
//         link.click();
//         URL.revokeObjectURL(link.href);
//       }, "image/png");

//       // Revert the SVG element to its original size
//       svgElement.setAttribute("width", originalWidth);
//       svgElement.setAttribute("height", originalHeight);
//       svgElement.setAttribute("viewBox", `0 0 ${originalWidth} ${originalHeight}`);
//     };

//     image.src = url;
//   });

//   // Initialize when Generate Button is Clicked
//   generateButton.addEventListener("click", function () {
//     modal.style.display = "flex";
//     console.log("Mind map generation started.");

//     const neo4j = require("neo4j-driver");

//     // Initialize Neo4j Driver
//     const driver = neo4j.driver("neo4j+s://7b2adf95.databases.neo4j.io", neo4j.auth.basic("neo4j", "INGaFxLI5FZnILVRQY6sG1ZOxtwzexRAXoCI2aeZ3UM"));

//     const session = driver.session();

//     const mindmapContainer = document.getElementById("graph-visualization");

//     if (!mindmapContainer) {
//       console.error("Mindmap container not found.");
//       return;
//     }

//     // Clear previous visualization (if any)
//     d3.select("#graph-visualization svg").remove();

//     // SVG and Canvas Setup
//     const width = mindmapContainer.clientWidth || 800;
//     const height = mindmapContainer.clientHeight || 600;

//     const svg = d3.select("#graph-visualization").append("svg").attr("width", "100%").attr("height", "100%").attr("viewBox", `0 0 ${width} ${height}`).attr("preserveAspectRatio", "xMidYMid meet").style("cursor", "pointer");

//     const zoomGroup = svg.append("g"); // Group for zooming and panning
//     const linkGroup = zoomGroup.append("g").attr("class", "links");
//     const nodeGroup = zoomGroup.append("g").attr("class", "nodes");

//     const zoomBehavior = d3
//       .zoom()
//       .scaleExtent([0.5, 5]) // Zoom range
//       .on("zoom", (event) => {
//         zoomGroup.attr("transform", event.transform);
//       });

//     svg.call(zoomBehavior);

//     let nodes = [];
//     let links = [];

//     const simulation = d3
//       .forceSimulation(nodes)
//       .force(
//         "link",
//         d3
//           .forceLink(links)
//           .id((d) => d.id)
//           .distance(150)
//       ) // Increase link distance
//       .force("charge", d3.forceManyBody().strength(-300)) // Adjust charge to space nodes apart
//       .force(
//         "collide",
//         d3.forceCollide().radius((d) => Math.max(30, d.text.length * 5) + 10)
//       ) // Avoid overlap
//       .force("center", d3.forceCenter(width / 2, height / 2))
//       .on("tick", ticked);

//     async function fetchFromDatabase() {
//       try {
//         const result = await session.run("MATCH (n)-[r]->(m) RETURN n, r, m");

//         // Clear previous data
//         nodes = [];
//         links = [];

//         result.records.forEach((record) => {
//           const source = record.get("n").properties;
//           const target = record.get("m").properties;
//           const relationship = record.get("r").type;

//           // Add nodes if not already in the array
//           if (!nodes.some((node) => node.id === source.name)) {
//             nodes.push({
//               id: source.name,
//               text: source.name,
//             });
//           }
//           if (!nodes.some((node) => node.id === target.name)) {
//             nodes.push({
//               id: target.name,
//               text: target.name,
//             });
//           }

//           links.push({
//             source: source.name,
//             target: target.name,
//             type: relationship,
//           });
//         });

//         const hierarchyData = buildHierarchy(nodes, links);
//         applyTreeLayout(hierarchyData);
//         update(); // Update visualization
//       } catch (error) {
//         console.error("Error fetching data from Neo4j:", error);
//       }
//     }

//     fetchFromDatabase();

//     function buildHierarchy(nodes, links) {
//       const nodeMap = new Map(nodes.map((node) => [node.id, node]));
//       links.forEach((link) => {
//         const parent = nodeMap.get(link.source);
//         const child = nodeMap.get(link.target);

//         if (!parent.children) {
//           parent.children = [];
//         }
//         parent.children.push(child);
//       });

//       // Assume the first node in `nodes` is the root
//       return d3.hierarchy(nodeMap.get(nodes[0].id));
//     }

//     function applyTreeLayout(hierarchyData) {
//       const treeLayout = d3.tree().size([width, height - 100]);
//       const treeData = treeLayout(hierarchyData);

//       treeData.descendants().forEach((d) => {
//         const node = nodes.find((n) => n.id === d.data.id);
//         if (node) {
//           node.x = d.x;
//           node.y = d.y;
//         }
//       });
//     }

//     let selectedLevel = null; // To store the currently selected level
//     const colorMap = {}; // To store custom colors for each level
//     const defaultColorScale = d3.scaleOrdinal(d3.schemeCategory10); // Define color scale at a global level

//     function update() {
//       console.log("Updating visualization...");

//       // Calculate the depth of each node
//       const hierarchyData = d3.hierarchy({
//         children: nodes.map((node) => ({
//           ...node,
//           children: links.filter((link) => link.source === node.id).map((link) => nodes.find((childNode) => childNode.id === link.target)),
//         })),
//       });

//       hierarchyData.each((node) => {
//         const dataNode = nodes.find((n) => n.id === node.data.id);
//         if (dataNode) {
//           dataNode.depth = node.depth; // Assign depth to each node
//         }
//       });

//       // Update Links
//       const link = linkGroup
//         .selectAll("line")
//         .data(links, (d) => `${d.source}-${d.target}`)
//         .join(
//           (enter) => enter.append("line").attr("stroke", "#999").attr("stroke-width", 2),
//           (update) => update,
//           (exit) => exit.remove()
//         );

//       // Update Nodes
//       const node = nodeGroup
//         .selectAll("g")
//         .data(nodes, (d) => d.id)
//         .join(
//           (enter) => {
//             const nodeEnter = enter
//               .append("g")
//               .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended))
//               .on("click", (event, d) => {
//                 // When a node is clicked, update the selected level
//                 selectedLevel = d.depth;
//                 console.log("Selected Level:", selectedLevel);

//                 // Set the color picker to the current level's color or default
//                 const colorPickerContainer = document.getElementById("color-picker-container");
//                 const colorPicker = document.getElementById("color-picker");

//                 colorPickerContainer.style.display = "block"; // Show color picker
//                 colorPicker.value = colorMap[selectedLevel] || defaultColorScale(d.depth || 0); // Set to current color
//               })
//               .on("dblclick", (event, d) => {
//                 // Create an input field for editing
//                 const input = document.createElement("input");
//                 input.type = "text";
//                 input.value = d.text;
//                 input.style.position = "absolute";
//                 input.style.left = `${event.pageX}px`;
//                 input.style.top = `${event.pageY}px`;
//                 input.style.zIndex = 1000;

//                 document.body.appendChild(input);

//                 // Focus on the input field
//                 input.focus();

//                 // Handle input blur (when editing is finished)
//                 input.addEventListener("blur", async () => {
//                   const updatedText = input.value.trim();
//                   if (updatedText && updatedText !== d.text) {
//                     try {
//                       // Update the database
//                       await session.run("MATCH (n {name: $oldName}) SET n.name = $newName RETURN n", {
//                         oldName: d.text,
//                         newName: updatedText,
//                       });

//                       // Update the node data
//                       d.text = updatedText;

//                       // Update the text in the visualization directly
//                       d3.select(event.target.parentNode).select("text").text(updatedText);

//                       console.log("Node updated successfully:", updatedText);
//                     } catch (error) {
//                       console.error("Error updating database:", error);
//                     }
//                   }

//                   // Remove the input field
//                   document.body.removeChild(input);
//                 });

//                 // Prevent propagation of the double-click event
//                 event.stopPropagation();
//               });

//             // Dynamically calculate ellipse dimensions based on text length
//             nodeEnter
//               .append("ellipse")
//               .attr("rx", (d) => Math.max(30, d.text.length * 5)) // Adjust width dynamically
//               .attr("ry", 30) // Fixed height
//               .attr("fill", (d) => colorMap[d.depth] || defaultColorScale(d.depth || 0)) // Use custom color or default
//               .attr("stroke", "#333")
//               .attr("stroke-width", 2);

//             nodeEnter
//               .append("text")
//               .attr("text-anchor", "middle")
//               .attr("alignment-baseline", "middle")
//               .text((d) => d.text);

//             return nodeEnter;
//           },
//           (update) => update.select("ellipse").attr("fill", (d) => colorMap[d.depth] || defaultColorScale(d.depth || 0)), // Update color
//           (exit) => exit.remove()
//         );

//       // Restart simulation
//       simulation.nodes(nodes);
//       simulation.force("link").links(links);
//       simulation.alpha(1).restart();

//       console.log("Nodes:", nodes);
//       console.log("Links:", links);
//     }

//     // Add Event Listener for Color Picker
//     document.getElementById("color-picker").addEventListener("input", (event) => {
//       const newColor = event.target.value;

//       if (selectedLevel !== null) {
//         // Update the color map for the selected level
//         colorMap[selectedLevel] = newColor;

//         // Re-render nodes with the updated colors
//         nodeGroup
//           .selectAll("g")
//           .select("ellipse")
//           .attr("fill", (d) => colorMap[d.depth] || defaultColorScale(d.depth || 0));
//       }
//     });

//     // Add global click listener to hide the color picker
//     document.addEventListener("click", (event) => {
//       const colorPickerContainer = document.getElementById("color-picker-container");
//       colorPickerContainer.style.display = "none"; // Hide color picker
//     });

//     // Prevent hiding when clicking on a node
//     nodeGroup.on("click", (event) => {
//       event.stopPropagation(); // Prevent the global click event from triggering
//     });

//     function ticked() {
//       linkGroup
//         .selectAll("line")
//         .attr("x1", (d) => calculateEdgePosition(d.source, d.target).x1)
//         .attr("y1", (d) => calculateEdgePosition(d.source, d.target).y1)
//         .attr("x2", (d) => calculateEdgePosition(d.source, d.target).x2)
//         .attr("y2", (d) => calculateEdgePosition(d.source, d.target).y2);

//       nodeGroup.selectAll("g").attr("transform", (d) => `translate(${d.x},${d.y})`);
//     }

//     function calculateEdgePosition(source, target) {
//       // Dimensions for source and target ellipses
//       const sourceRx = Math.max(30, source.text.length * 5);
//       const sourceRy = 30;
//       const targetRx = Math.max(30, target.text.length * 5);
//       const targetRy = 30;

//       // Parent connects to bottom-middle
//       const sourceX = source.x;
//       const sourceY = source.y + sourceRy;

//       // Child connects to top-middle
//       const targetX = target.x;
//       const targetY = target.y - targetRy;

//       return {
//         x1: sourceX,
//         y1: sourceY,
//         x2: targetX,
//         y2: targetY,
//       };
//     }

//     function dragstarted(event, d) {
//       // Stop the simulation for all nodes to allow independent movement
//       simulation.alpha(0).stop();
//       d.fx = d.x;
//       d.fy = d.y;
//     }

//     function dragged(event, d) {
//       d.fx = event.x;
//       d.fy = event.y;

//       // Update the dragged node's position in the nodes array
//       nodes.forEach((node) => {
//         if (node.id === d.id) {
//           node.x = d.fx;
//           node.y = d.fy;
//         }
//       });

//       // Update the dragged node's position visually
//       nodeGroup
//         .selectAll("g")
//         .filter((node) => node.id === d.id)
//         .attr("transform", `translate(${d.fx},${d.fy})`);

//       // Dynamically update only the links connected to the dragged node
//       linkGroup
//         .selectAll("line")
//         .filter((line) => line.source.id === d.id || line.target.id === d.id)
//         .attr("x1", (line) => {
//           return line.source.id === d.id ? d.fx : line.source.x;
//         })
//         .attr("y1", (line) => {
//           return line.source.id === d.id ? d.fy : line.source.y;
//         })
//         .attr("x2", (line) => {
//           return line.target.id === d.id ? d.fx : line.target.x;
//         })
//         .attr("y2", (line) => {
//           return line.target.id === d.id ? d.fy : line.target.y;
//         });
//     }

//     function dragended(event, d) {
//       // Release the dragged node and allow it to stay in the final position
//       d.fx = null;
//       d.fy = null;
//     }
//   });
// });

document.addEventListener("DOMContentLoaded", function () {
  const generateButton = document.getElementById("generate-mindmap");
  const downloadButton = document.getElementById("download-map");
  const modal = document.getElementById("mindmap-modal");
  const closeModalButton = document.getElementById("close-modal");
  const addNode = document.getElementById("add-node");
  const addRelation = document.getElementById("add-relation");

  let nodes = [];
  let links = [];

  let width = 800;
  let height = 600;

  let colorMap = {};
  let defaultColorScale = d3.scaleOrdinal(d3.schemeCategory10);
  let selectedLevel = null;

  let selectedNode = null;
  let selectedLink = null;

  // NEW: Move these references to global scope, so “Add Node” sees the newest ones
  let svg, zoomGroup, linkGroup, nodeGroup, simulation;

  if (!generateButton || !modal || !downloadButton) {
    console.error("Required elements not found.");
    return;
  }

  let isAddNodeListenerAttached = false;
  let isAddRelationListenerAttached = false;
  let isDeleteListenerAttached = false;

  // Close Modal
  closeModalButton.addEventListener("click", function () {
    modal.style.display = "none";

    if (d3.select("#graph-visualization svg").node()) {
      console.log("SVG before removal:", d3.select("#graph-visualization svg").node());
    } else {
      console.log("No SVG found before removal.");
    }

    d3.select("#graph-visualization svg").remove();

    if (d3.select("#graph-visualization svg").node()) {
      console.log("SVG after removal:", d3.select("#graph-visualization svg").node());
    } else {
      console.log("No SVG found after removal.");
    }
    console.log("Modal closed.");
  });

  // Function to download the mind map as an image
  downloadButton.addEventListener("click", function () {
    const svgElement = document.querySelector("#graph-visualization svg");

    if (!svgElement) {
      console.error("SVG element not found.");
      return;
    }

    // Temporarily adjust SVG size to fit all nodes and links
    const bbox = svgElement.getBBox();
    const originalWidth = svgElement.getAttribute("width");
    const originalHeight = svgElement.getAttribute("height");

    svgElement.setAttribute("width", bbox.width);
    svgElement.setAttribute("height", bbox.height);
    svgElement.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);

    // Convert SVG to data URL
    const svgData = new XMLSerializer().serializeToString(svgElement);
    const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    // Create an image to render the SVG
    const image = new Image();
    image.onload = () => {
      const scale = 3; // Increase this value for higher quality
      const canvas = document.createElement("canvas");
      canvas.width = bbox.width * scale;
      canvas.height = bbox.height * scale;

      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white"; // Optional: Set background color
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Scale the context to render a higher resolution
      ctx.scale(scale, scale);
      ctx.drawImage(image, 0, 0);

      // Trigger download of PNG
      canvas.toBlob((blob) => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "mindmap.png";
        link.click();
        URL.revokeObjectURL(link.href);
      }, "image/png");

      // Revert the SVG element to its original size
      svgElement.setAttribute("width", originalWidth);
      svgElement.setAttribute("height", originalHeight);
      svgElement.setAttribute("viewBox", `0 0 ${originalWidth} ${originalHeight}`);
    };

    image.src = url;
  });

  // Initialize when Generate Button is Clicked
  generateButton.addEventListener("click", function () {
    let selectedText = "";

    if (typeof padeditor !== "undefined" && padeditor.ace) {
      console.log("Calling Ace editor API...");
      padeditor.ace.callWithAce(
        (ace) => {
          const rep = ace.ace_getRep();
          const selStart = rep.selStart;
          const selEnd = rep.selEnd;

          if (selStart && selEnd) {
            const lines = rep.lines.slice(selStart[0], selEnd[0] + 1);

            lines.forEach((line, index) => {
              const startCol = index === 0 ? selStart[1] : 0;
              const endCol = index === lines.length - 1 ? selEnd[1] : line.text.length;
              selectedText += line.text.substring(startCol, endCol);

              if (index < lines.length - 1) {
                selectedText += "\n";
              }
            });

            console.log("Selected Text:", selectedText);

            modal.style.display = "flex";
            console.log("Modal opened with content.");
          } else {
            console.warn("No text selected.");
          }
        },
        "getSelectedText",
        true
      );
    } else {
      console.error("Etherpad's padeditor or Ace editor is not initialized.");
    }

    modal.style.display = "flex";
    console.log("Mind map generation started.");

    // Clear previous visualization (if any)
    d3.select("#graph-visualization svg").remove();

    const mindmapContainer = document.getElementById("graph-visualization");

    if (!mindmapContainer) {
      console.error("Mindmap container not found.");
      return;
    }

    width = mindmapContainer.clientWidth || 800;
    height = mindmapContainer.clientHeight || 600;

    // INSTEAD OF "const", we now ASSIGN our global variables:
    svg = d3
      .select("#graph-visualization")
      .append("svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("viewBox", `0 0 ${mindmapContainer.clientWidth || 800} ${mindmapContainer.clientHeight || 600}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("cursor", "pointer");

    zoomGroup = svg.append("g"); // Group for zooming and panning
    linkGroup = zoomGroup.append("g").attr("class", "links");
    nodeGroup = zoomGroup.append("g").attr("class", "nodes");

    const zoomBehavior = d3
      .zoom()
      .scaleExtent([0.5, 5]) // Zoom range
      .on("zoom", (event) => {
        zoomGroup.attr("transform", event.transform);
      });

    svg.call(zoomBehavior);

    // SAME: define a global "simulation"
    simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(150)
      ) // Increase link distance
      .force("charge", d3.forceManyBody().strength(-300)) // Adjust charge to space nodes apart
      .force(
        "collide",
        d3.forceCollide().radius((d) => Math.max(30, d.text.length * 5) + 10)
      ) // Avoid overlap
      .force("center", d3.forceCenter((mindmapContainer.clientWidth || 800) / 2, (mindmapContainer.clientHeight || 600) / 2))
      .on("tick", ticked);

    // async function fetchFromDatabase() {
    //   try {
    //     // Adjust URL/endpoint as needed:
    //     const baseApiUrl = "https://e4e5-34-16-190-82.ngrok-free.app";
    //     const endpoint = "generate";

    //     const response = await fetch(`${baseApiUrl}/${endpoint}`, {
    //       method: "POST",
    //       headers: { "Content-Type": "application/json" },
    //       body: JSON.stringify({ input_text: selectedText }),
    //     });

    //     if (!response.ok) {
    //       throw new Error(`Server error: ${response.status}`);
    //     }

    //     const data = await response.json();
    //     console.log("Parsed JSON Data:", data);
    //     const mindmapRoot = data.response;

    //     // Clear previous data
    //     nodes.splice(0, nodes.length);
    //     links.splice(0, links.length);

    //     // Recursively traverse the returned structure
    //     if (mindmapRoot && mindmapRoot.mindmap && Array.isArray(mindmapRoot.mindmap)) {
    //       mindmapRoot.mindmap.forEach((mindmapNode) => {
    //         traverseMindmap(mindmapNode, null);
    //       });
    //     }

    //     // After populating nodes/links, update the visualization
    //     const hierarchyData = buildHierarchy(nodes, links);
    //     applyTreeLayout(hierarchyData);
    //     update(); // Re-render
    //   } catch (error) {
    //     console.error("Error fetching data from API:", error);
    //   }
    // }

    async function fetchFromDatabase() {
      try {
        // Skip the actual fetch call, and just return mock data

        defaultColorScale = d3.scaleOrdinal(d3.schemeCategory10);
        colorMap = {};
        window.nodeColorMap = new Map();

        // let data;

        // // Check the user’s selected text. If you store `selectedText` in a higher scope,
        // // you can do something like:
        // const chosen = selectedText.trim(); // or however you read it

        // // Based on user input, set `data`
        // if (chosen === "1") {
        //   data = {
        //     mindmap: [
        //       {
        //         name: "IOT and Big Data",
        //         subnodes: [
        //           {
        //             name: "IOT",
        //             subnodes: [
        //               { name: "Main Application of Big Data", subnodes: [] },
        //               { name: "High Diversity of Things", subnodes: [] },
        //               { name: "Machine-to-Machine Communication", subnodes: [] },
        //               {
        //                 name: "Track and Locate Positions of Vehicles",
        //                 subnodes: [
        //                   { name: "Sensor Data", subnodes: [] },
        //                   { name: "Wireless Adaptors", subnodes: [] },
        //                   { name: "GPS", subnodes: [] },
        //                 ],
        //               },
        //             ],
        //           },
        //           {
        //             name: "Large Information Frameworks",
        //             subnodes: [{ name: "IOT Information Collection and Storage", subnodes: [] }],
        //           },
        //         ],
        //       },
        //     ],
        //   };
        // } else if (chosen === "2") {
        //   data = {
        //     mindmap: [
        //       {
        //         name: "Artificial Neural Networks (ANN)",
        //         subnodes: [
        //           { name: "Developed based on Biological Neurons", subnodes: [] },
        //           {
        //             name: "Perceptron",
        //             subnodes: [
        //               { name: "Trained to Predict", subnodes: [] },
        //               { name: "Fixed Threshold", subnodes: [] },
        //             ],
        //           },
        //           {
        //             name: "Architecture",
        //             subnodes: [
        //               { name: "Many Inputs", subnodes: [] },
        //               { name: "Multiple Processing Layers", subnodes: [] },
        //               { name: "Many Outputs", subnodes: [] },
        //             ],
        //           },
        //           {
        //             name: "Complex Data",
        //             subnodes: [
        //               { name: "Classification Tasks", subnodes: [] },
        //               { name: "Regression Tasks", subnodes: [] },
        //             ],
        //           },
        //         ],
        //       },
        //     ],
        //   };
        // } else {
        //   data = {
        //     mindmap: [
        //       {
        //         name: "Machine Learning in Healthcare",
        //         subnodes: [
        //           {
        //             name: "Overview",
        //             subnodes: [
        //               { name: "Widely used in applications and research", subnodes: [] },
        //               { name: "Crucial role in numerous fields", subnodes: [] },
        //               {
        //                 name: "Applications",
        //                 subnodes: [
        //                   { name: "Diagnose sizeable medical data patterns", subnodes: [] },
        //                   { name: "Predict diseases", subnodes: [] },
        //                 ],
        //               },
        //             ],
        //           },
        //           {
        //             name: "Survey",
        //             subnodes: [
        //               {
        //                 name: "Purpose",
        //                 subnodes: [
        //                   { name: "Highlight previous work", subnodes: [] },
        //                   { name: "Provide information to researchers", subnodes: [] },
        //                 ],
        //               },
        //               {
        //                 name: "Machine Learning Algorithms",
        //                 subnodes: [
        //                   { name: "Overview", subnodes: [] },
        //                   { name: "Applications in healthcare", subnodes: [] },
        //                 ],
        //               },
        //             ],
        //           },
        //           {
        //             name: "Advantages",
        //             subnodes: [
        //               { name: "Efficient support infrastructure for medical fields", subnodes: [] },
        //               { name: "Improve healthcare services", subnodes: [] },
        //             ],
        //           },
        //         ],
        //       },
        //     ],
        //   };
        // }

        // // "data" now contains the mindmap => parse it as if from API
        // console.log("Mock Data Chosen:", data);

        // // Clear previous data
        // nodes.splice(0, nodes.length);
        // links.splice(0, links.length);

        // // Recursively traverse the returned structure
        // if (data && data.mindmap && Array.isArray(data.mindmap)) {
        //   data.mindmap.forEach((mindmapNode) => {
        //     traverseMindmap(mindmapNode, null);
        //   });
        // }

        // Adjust URL/endpoint as needed:
        const baseApiUrl = "https://616b-34-34-37-161.ngrok-free.app";
        const endpoint = "generate";

        const response = await fetch(`${baseApiUrl}/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input_text: selectedText }),
        });

        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }

        const data = await response.json();
        console.log("Parsed JSON Data:", data);
        const mindmapRoot = data.response;

        // Clear previous data
        nodes.splice(0, nodes.length);
        links.splice(0, links.length);

        // Recursively traverse the returned structure
        if (mindmapRoot && mindmapRoot.mindmap && Array.isArray(mindmapRoot.mindmap)) {
          mindmapRoot.mindmap.forEach((mindmapNode) => {
            traverseMindmap(mindmapNode, null);
          });
        }

        // After populating nodes/links, update the visualization
        const hierarchyData = buildHierarchy(nodes, links);
        applyTreeLayout(hierarchyData);
        update(); // Re-render
      } catch (error) {
        console.error("Error fetching data from mock data:", error);
      }
    }

    function traverseMindmap(nodeData, parentData) {
      if (!nodeData || !nodeData.name) return;

      if (!nodes.some((existingNode) => existingNode.id === nodeData.name)) {
        nodes.push({
          id: nodeData.name,
          text: nodeData.name,
        });
      }

      if (parentData && parentData.name) {
        links.push({
          source: parentData.name,
          target: nodeData.name,
          type: "HAS_SUBNODE",
        });
      }

      if (Array.isArray(nodeData.subnodes)) {
        nodeData.subnodes.forEach((subnode) => traverseMindmap(subnode, nodeData));
      }
    }

    fetchFromDatabase()
      .then(() => console.log("API fetch completed"))
      .catch((err) => console.error("Error in fetchFromApi:", err));

    function buildHierarchy(nodes, links) {
      const nodeMap = new Map(nodes.map((node) => [node.id, node]));

      // Ensure each node has a `children` property initialized
      nodes.forEach((node) => {
        if (!node.children) {
          node.children = [];
        }
      });

      // Add children to parent nodes based on links
      links.forEach((link) => {
        const parent = nodeMap.get(link.source);
        const child = nodeMap.get(link.target);

        if (parent && child) {
          parent.children.push(child);
        }
      });

      // Identify root nodes (nodes with no incoming links)
      const allTargets = new Set(links.map((link) => link.target));
      const rootNodes = nodes.filter((node) => !allTargets.has(node.id));

      console.log("Root Nodes:", rootNodes);

      // If no explicit root exists, take the first node as root
      if (rootNodes.length === 0) {
        console.warn("No explicit root node found. Using the first node as the root.");
        return d3.hierarchy(nodeMap.get(nodes[0].id));
      }

      // Handle multiple root nodes by creating a virtual root
      if (rootNodes.length > 1) {
        const virtualRoot = { id: "virtualRoot", text: "Root", children: rootNodes };
        const h = d3.hierarchy(virtualRoot);

        // ✅ Minimal one-line fix: shift every descendant's depth down by 1
        h.each((n) => {
          n.depth = Math.max(0, n.depth - 1);
        });

        return h;
      }

      // Build hierarchy starting from the single root node
      const hierarchy = d3.hierarchy(nodeMap.get(rootNodes[0].id));

      // Assign depths to nodes in the hierarchy
      // Minimal fix: only assign depth if it's null (not set)
      hierarchy.each((node) => {
        const dataNode = nodeMap.get(node.data.id);
        if (dataNode && dataNode.depth == null) {
          dataNode.depth = node.depth;
        }
      });

      // Handle standalone nodes (nodes without any links)
      const connectedNodes = new Set(links.flatMap((link) => [link.source, link.target]));
      const standaloneNodes = nodes.filter((node) => !connectedNodes.has(node.id));

      standaloneNodes.forEach((node) => {
        // Only set depth to 0 if it's null/undefined,
        // i.e. hasn't been assigned by the hierarchy
        if (node.depth == null) {
          node.depth = 0;
          console.log(`Standalone Node Assigned Depth 0: ${node.id}`);
        }
      });

      return hierarchy;
    }

    function applyTreeLayout(hierarchyData) {
      const treeLayout = d3.tree().size([width, height - 100]);
      const treeData = treeLayout(hierarchyData);

      treeData.descendants().forEach((d) => {
        const node = nodes.find((n) => n.id === d.data.id);
        if (node) {
          node.x = d.x;
          node.y = d.y;
        }
      });
    }

    function update() {
      console.log("Updating visualization...");

      // Ensure nodeColorMap persists across updates
      if (!window.nodeColorMap) {
        window.nodeColorMap = new Map();
      }

      // Preserve existing positions
      const nodePositionMap = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));

      // Build hierarchy for nodes with links
      const hierarchyData = buildHierarchy(nodes, links);

      // Minimal fix: only assign depth if it's null
      hierarchyData.each((node) => {
        const dataNode = nodes.find((n) => n.id === node.data.id);
        if (dataNode && dataNode.depth == null) {
          dataNode.depth = node.depth;
          if (!colorMap[node.depth]) {
            colorMap[node.depth] = defaultColorScale(node.depth);
          }
        }
      });

      // Assign depth 0 color to standalone nodes and ensure color persistence
      const rootColor = colorMap[0] || defaultColorScale(0);
      nodes.forEach((node) => {
        const isStandalone = !links.some((link) => link.source === node.id || link.target === node.id);

        if (isStandalone && node.depth === undefined) {
          node.depth = 0; // Assign root depth if undefined
        }

        // Assign color only if not already present in the persistent map
        if (!window.nodeColorMap.has(node.id)) {
          const color = isStandalone ? rootColor : colorMap[node.depth] || defaultColorScale(node.depth);
          window.nodeColorMap.set(node.id, color);
        }
      });

      // Re-check node depth and color
      nodes.forEach((node) => {
        const hasLinks = links.some((link) => link.source === node.id || link.target === node.id);
        if (hasLinks) {
          if (node.depth === undefined || node.depth === 0) {
            // Attempt to find correct depth in hierarchy
            const found = hierarchyData.find((h) => h.data.id === node.id);
            node.depth = found ? found.depth : 0;
          }
        }

        // Update color
        const newColor = colorMap[node.depth] || defaultColorScale(node.depth);
        window.nodeColorMap.set(node.id, newColor);

        // Force standalone depth 0
        const isStandalone = !links.some((link) => link.source === node.id || link.target === node.id);
        if (isStandalone && node.depth == null) {
          node.depth = 0;
          const color = colorMap[0] || defaultColorScale(0);
          window.nodeColorMap.set(node.id, color);
        }
      });

      console.log(
        "Updated Node Depths:",
        nodes.map((n) => ({ id: n.id, depth: n.depth }))
      );
      console.log("Updated Color Map:", colorMap);

      // Update Links
      const link = linkGroup
        .selectAll("line")
        .data(links, (d) => `${d.source}-${d.target}`)
        .join(
          (enter) =>
            enter
              .append("line")
              .attr("stroke", "#999")
              .attr("stroke-width", 2)
              // ADDED: On click for link blinking
              .on("click", (event, d) => {
                selectedLink = d;
                selectedNode = null; // Deselect any node
                updateBlinking();
                event.stopPropagation(); // Don’t trigger background clicks
              }),
          (update) => update,
          (exit) => exit.remove()
        );

      // Update Nodes
      const node = nodeGroup
        .selectAll("g")
        .data(nodes, (d) => d.id)
        .join(
          (enter) => {
            const nodeEnter = enter
              .append("g")
              .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended))
              .on("click", (event, d) => {
                selectedLevel = d.depth;
                console.log("Selected Level:", selectedLevel);

                const colorPickerContainer = document.getElementById("color-picker-container");
                const colorPicker = document.getElementById("color-picker");

                colorPickerContainer.style.display = "block"; // Show color picker
                colorPicker.value = colorMap[selectedLevel] || defaultColorScale(d.depth || 0); // Set to current color

                // ADDED: For node blinking
                selectedNode = d;
                selectedLink = null;
                updateBlinking();
                event.stopPropagation(); // Don’t trigger background clicks
              })
              .on("dblclick", (event, d) => {
                const input = document.createElement("input");
                input.type = "text";
                input.value = d.text;
                input.style.position = "absolute";
                input.style.left = `${event.pageX}px`;
                input.style.top = `${event.pageY}px`;
                input.style.zIndex = 1000;

                document.body.appendChild(input);
                input.focus();

                // -------------------------------------
                //  REMOVE session.run() for rename
                // -------------------------------------
                input.addEventListener("blur", () => {
                  const updatedText = input.value.trim();
                  if (updatedText && updatedText !== d.text) {
                    // Just update the array + D3 text
                    // 1) Update the node’s text
                    d.text = updatedText;

                    // 2) If you use the node’s id as a unique identifier, rename it in the nodes array and links
                    const oldID = d.id;
                    d.id = updatedText; // or keep some stable ID if needed

                    // 3) Update the name in the top-level `nodes` array
                    const nodeObj = nodes.find((n) => n.id === oldID);
                    if (nodeObj) {
                      nodeObj.id = updatedText;
                      nodeObj.text = updatedText;
                    }

                    // 4) Update any links referencing the old node id
                    links.forEach((link) => {
                      if (link.source === oldID) {
                        link.source = updatedText;
                      }
                      if (link.target === oldID) {
                        link.target = updatedText;
                      }
                    });

                    d3.select(event.target.parentNode).select("text").text(updatedText);
                    console.log("Node updated successfully:", updatedText);
                  }
                  document.body.removeChild(input);
                });

                event.stopPropagation();
              });

            nodeEnter
              .append("ellipse")
              .attr("rx", (d) => Math.max(30, d.text.length * 5))
              .attr("ry", 30)
              .attr("fill", (d) => window.nodeColorMap.get(d.id))
              .attr("stroke", "#333")
              .attr("stroke-width", 2);

            nodeEnter
              .append("text")
              .attr("text-anchor", "middle")
              .attr("alignment-baseline", "middle")
              .text((d) => d.text);

            return nodeEnter;
          },
          (update) =>
            update
              .attr("transform", (d) => {
                const position = nodePositionMap.get(d.id);
                if (position) {
                  d.fx = position.x;
                  d.fy = position.y;
                  return `translate(${position.x},${position.y})`;
                }
                return `translate(${d.x},${d.y})`;
              })
              .select("ellipse")
              .attr("fill", (d) => window.nodeColorMap.get(d.id)),
          (exit) => exit.remove()
        );

      // Restart simulation for only new nodes
      simulation.nodes(nodes);
      simulation.force("link").links(links);
      simulation.alpha(1).restart();

      console.log("Nodes:", nodes);
      console.log("Links:", links);
    }

    // Add Event Listener for Color Picker
    document.getElementById("color-picker").addEventListener("input", (event) => {
      const newColor = event.target.value;

      if (selectedLevel !== null) {
        // Update the color map for the selected level
        colorMap[selectedLevel] = newColor;

        // Re-render nodes with the updated colors
        nodeGroup
          .selectAll("g")
          .select("ellipse")
          .attr("fill", (d) => colorMap[d.depth] || defaultColorScale(d.depth || 0));
      }
    });

    // Add global click listener to hide the color picker
    document.addEventListener("click", (event) => {
      const colorPickerContainer = document.getElementById("color-picker-container");
      colorPickerContainer.style.display = "none"; // Hide color picker
      selectedNode = null;
      selectedLink = null;
      updateBlinking();
    });

    // Prevent hiding when clicking on a node
    nodeGroup.on("click", (event) => {
      event.stopPropagation(); // Prevent the global click event from triggering
    });

    function ticked() {
      linkGroup
        .selectAll("line")
        .attr("x1", (d) => calculateEdgePosition(d.source, d.target).x1)
        .attr("y1", (d) => calculateEdgePosition(d.source, d.target).y1)
        .attr("x2", (d) => calculateEdgePosition(d.source, d.target).x2)
        .attr("y2", (d) => calculateEdgePosition(d.source, d.target).y2);

      nodeGroup.selectAll("g").attr("transform", (d) => `translate(${d.x},${d.y})`);
    }

    function calculateEdgePosition(source, target) {
      // Dimensions for source and target ellipses
      const sourceRx = Math.max(30, source.text.length * 5);
      const sourceRy = 30;
      const targetRx = Math.max(30, target.text.length * 5);
      const targetRy = 30;

      // Parent connects to bottom-middle
      const sourceX = source.x;
      const sourceY = source.y + sourceRy;

      // Child connects to top-middle
      const targetX = target.x;
      const targetY = target.y - targetRy;

      return {
        x1: sourceX,
        y1: sourceY,
        x2: targetX,
        y2: targetY,
      };
    }

    function dragstarted(event, d) {
      simulation.alpha(0).stop();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;

      nodes.forEach((node) => {
        if (node.id === d.id) {
          node.x = d.fx;
          node.y = d.fy;
        }
      });

      nodeGroup
        .selectAll("g")
        .filter((node) => node.id === d.id)
        .attr("transform", `translate(${d.fx},${d.fy})`);

      linkGroup
        .selectAll("line")
        .filter((line) => line.source.id === d.id || line.target.id === d.id)
        .attr("x1", (line) => (line.source.id === d.id ? d.fx : line.source.x))
        .attr("y1", (line) => (line.source.id === d.id ? d.fy : line.source.y))
        .attr("x2", (line) => (line.target.id === d.id ? d.fx : line.target.x))
        .attr("y2", (line) => (line.target.id === d.id ? d.fy : line.target.y));
    }

    function dragended(event, d) {
      d.fx = null;
      d.fy = null;
    }

    // Add event listener for "Add Node" button
    if (!isAddNodeListenerAttached) {
      addNode.addEventListener("click", function handleAddNodeClick() {
        const newNodeName = document.getElementById("new-node-name").value.trim();

        if (!newNodeName) {
          console.error("Node name cannot be empty.");
          alert("Please enter a valid node name.");
          return;
        }

        addNode.disabled = true;

        console.log("Current nodes array:", nodes);
        if (nodes.some((node) => node.id === newNodeName)) {
          console.error("Node with this name already exists.");
          alert("A node with this name already exists. Please use a different name.");
          addNode.disabled = false;
          return;
        }

        console.log(`Node '${newNodeName}' added (in-memory only).`);

        const newNode = {
          id: newNodeName,
          text: newNodeName,
          x: nodes.length > 0 ? d3.mean(nodes, (node) => node.x) || 400 : 400,
          y: nodes.length > 0 ? d3.mean(nodes, (node) => node.y) || 300 : 300,
          depth: null,
        };

        nodes.push(newNode);

        update(); // Uses the *latest* nodeGroup, simulation, etc.
        console.log(`Node '${newNodeName}' added to the visualization.`);

        addNode.disabled = false;
        document.getElementById("new-node-name").value = "";
      });

      isAddNodeListenerAttached = true;
    }

    if (!isAddRelationListenerAttached) {
      addRelation.addEventListener("click", function () {
        const sourceName = document.getElementById("add-relation-source").value.trim();
        const targetName = document.getElementById("add-relation-target").value.trim();

        if (!sourceName || !targetName) {
          alert("Please enter both source and target node names.");
          return;
        }

        if (sourceName === targetName) {
          alert("Source and target nodes cannot be the same.");
          return;
        }

        const sourceNode = nodes.find((node) => node.id === sourceName);
        const targetNode = nodes.find((node) => node.id === targetName);

        if (!sourceNode || !targetNode) {
          alert("One or both nodes do not exist. Please enter valid node names.");
          return;
        }

        console.log(`✅ Relation added (in arrays): ${sourceName} → ${targetName}`);

        links.push({ source: sourceName, target: targetName, type: "HAS_SUBNODE" });

        // Step 1: Only update depth of target node, based on its new parent
        const nodeMap = new Map(nodes.map((node) => [node.id, node]));
        targetNode.depth = sourceNode.depth + 1; // Ensure the new child is exactly one level deeper

        // Step 2: Update depths of all descendants of the newly linked node
        updateDepthsRecursively(targetNode, nodeMap, links);

        // Step 3: Ensure colors update based on the new depths
        nodes.forEach((node) => {
          if (!colorMap[node.depth]) {
            colorMap[node.depth] = defaultColorScale(node.depth);
          }
          window.nodeColorMap.set(node.id, colorMap[node.depth]);
        });

        update(); // Refresh visualization

        document.getElementById("add-relation-source").value = "";
        document.getElementById("add-relation-target").value = "";
      });

      isAddRelationListenerAttached = true;
    }

    function updateBlinking() {
      // Remove blinking from all nodes and links
      nodeGroup.selectAll("ellipse").classed("blinking", false);
      linkGroup.selectAll("line").classed("blinking", false);

      if (selectedNode) {
        nodeGroup
          .selectAll("g")
          .filter((node) => node.id === selectedNode.id)
          .select("ellipse")
          .classed("blinking", true); // applies the blink-border style
      }

      if (selectedLink) {
        linkGroup
          .selectAll("line")
          .filter((link) => link.source.id === selectedLink.source.id && link.target.id === selectedLink.target.id)
          .classed("blinking", true); // applies the blink-animation style
      }
    }

    // Helper function to recursively update depths of descendants
    function updateDepthsRecursively(node, nodeMap, links) {
      let queue = [{ node, depth: node.depth }];

      while (queue.length > 0) {
        let { node, depth } = queue.shift();
        node.depth = depth; // Assign correct depth

        let children = links.filter((l) => (typeof l.source === "object" ? l.source.id === node.id : l.source === node.id)).map((l) => nodeMap.get(typeof l.target === "object" ? l.target.id : l.target));

        children.forEach((child) => {
          if (child) {
            queue.push({ node: child, depth: depth + 1 });
          }
        });
      }
    }

    if (!isDeleteListenerAttached) {
      document.addEventListener("keydown", function (event) {
        if (event.key === "Delete") {
          let hierarchyData;
          let deletedNodeId = null;
          let affectedNodes = new Set();

          if (selectedNode) {
            deletedNodeId = selectedNode.id;
            console.log(`🗑️ Deleting node: ${deletedNodeId}`);

            let children = links.filter((l) => (typeof l.source === "object" ? l.source.id === deletedNodeId : l.source === deletedNodeId)).map((l) => (typeof l.target === "object" ? l.target.id : l.target));

            console.log(`🚸 Children of deleted node: ${children}`);

            let parentNode = links.find((l) => (typeof l.target === "object" ? l.target.id === deletedNodeId : l.target === deletedNodeId));

            let parentId = parentNode ? (typeof parentNode.source === "object" ? parentNode.source.id : parentNode.source) : null;

            console.log(`👨‍👩‍👧 Parent of deleted node: ${parentId}`);

            nodes = nodes.filter((n) => n.id !== deletedNodeId);
            links = links.filter((l) => {
              if (typeof l.source === "object") {
                return l.source.id !== deletedNodeId && l.target.id !== deletedNodeId;
              } else {
                return l.source !== deletedNodeId && l.target !== deletedNodeId;
              }
            });

            // Assign children their correct depths instead of promoting
            children.forEach((childId) => {
              affectedNodes.add(childId);
            });

            selectedNode = null;
          } else if (selectedLink) {
            console.log(`🗑️ Deleting link: ${selectedLink.source.id} → ${selectedLink.target.id}`);
            let orphanNode = selectedLink.target.id;
            affectedNodes.add(orphanNode);

            links = links.filter((l) => {
              if (typeof l.source === "object") {
                return !(l.source.id === selectedLink.source.id && l.target.id === selectedLink.target.id);
              } else {
                return !(l.source === selectedLink.source && l.target === selectedLink.target);
              }
            });

            selectedLink = null;
          }

          // Step 1: Recalculate hierarchy
          hierarchyData = buildHierarchy(nodes, links);

          // Step 2: Update depth for each affected node
          const nodeMap = new Map(nodes.map((node) => [node.id, node]));

          affectedNodes.forEach((nodeId) => {
            let node = nodeMap.get(nodeId);
            if (node) {
              const parentLink = links.find((l) => {
                return typeof l.target === "object" ? l.target.id === node.id : l.target === node.id;
              });

              if (parentLink) {
                let parent = nodeMap.get(typeof parentLink.source === "object" ? parentLink.source.id : parentLink.source);
                node.depth = parent ? parent.depth + 1 : 0;
              } else {
                console.log(`🔄 Orphaned node '${node.id}' assigned to root level.`);
                node.depth = 0;
              }

              // Recursively update depths of descendants
              updateDepthsRecursively(node, nodeMap, links);
            }
          });

          // Step 3: Update colors based on new depth levels
          nodes.forEach((node) => {
            if (!colorMap[node.depth]) {
              colorMap[node.depth] = defaultColorScale(node.depth);
            }
            window.nodeColorMap.set(node.id, colorMap[node.depth]);
          });

          console.log(
            "Updated Node Depths:",
            nodes.map((n) => ({ id: n.id, depth: n.depth }))
          );
          console.log("Updated Color Map:", colorMap);
          console.log("Updated Links:", links);

          updateBlinking();
          update();
        }
      });
      isDeleteListenerAttached = true;
    }
  });
});

// document.addEventListener("DOMContentLoaded", function () {
//   const generateButton = document.getElementById("generate-mindmap");
//   const downloadButton = document.getElementById("download-map");
//   const modal = document.getElementById("mindmap-modal");
//   const closeModalButton = document.getElementById("close-modal");
//   const addNode = document.getElementById("add-node");
//   const addRelation = document.getElementById("add-relation");

//   let nodes = [];
//   let links = [];

//   if (!generateButton || !modal || !downloadButton) {
//     console.error("Required elements not found.");
//     return;
//   }

//   let isAddNodeListenerAttached = false;

//   // Close Modal
//   closeModalButton.addEventListener("click", function () {
//     modal.style.display = "none";

//     if (d3.select("#graph-visualization svg").node()) {
//       console.log("SVG before removal:", d3.select("#graph-visualization svg").node());
//     } else {
//       console.log("No SVG found before removal.");
//     }

//     d3.select("#graph-visualization svg").remove();

//     if (d3.select("#graph-visualization svg").node()) {
//       console.log("SVG after removal:", d3.select("#graph-visualization svg").node());
//     } else {
//       console.log("No SVG found after removal.");
//     }
//     console.log("Modal closed.");
//   });

//   // Function to download the mind map as an image
//   downloadButton.addEventListener("click", function () {
//     const svgElement = document.querySelector("#graph-visualization svg");

//     if (!svgElement) {
//       console.error("SVG element not found.");
//       return;
//     }

//     // Temporarily adjust SVG size to fit all nodes and links
//     const bbox = svgElement.getBBox();
//     const originalWidth = svgElement.getAttribute("width");
//     const originalHeight = svgElement.getAttribute("height");

//     svgElement.setAttribute("width", bbox.width);
//     svgElement.setAttribute("height", bbox.height);
//     svgElement.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);

//     // Convert SVG to data URL
//     const svgData = new XMLSerializer().serializeToString(svgElement);
//     const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
//     const url = URL.createObjectURL(svgBlob);

//     // Create an image to render the SVG
//     const image = new Image();
//     image.onload = () => {
//       const scale = 3; // Increase this value for higher quality
//       const canvas = document.createElement("canvas");
//       canvas.width = bbox.width * scale;
//       canvas.height = bbox.height * scale;

//       const ctx = canvas.getContext("2d");
//       ctx.fillStyle = "white"; // Optional: Set background color
//       ctx.fillRect(0, 0, canvas.width, canvas.height);

//       // Scale the context to render a higher resolution
//       ctx.scale(scale, scale);
//       ctx.drawImage(image, 0, 0);

//       // Trigger download of PNG
//       canvas.toBlob((blob) => {
//         const link = document.createElement("a");
//         link.href = URL.createObjectURL(blob);
//         link.download = "mindmap.png";
//         link.click();
//         URL.revokeObjectURL(link.href);
//       }, "image/png");

//       // Revert the SVG element to its original size
//       svgElement.setAttribute("width", originalWidth);
//       svgElement.setAttribute("height", originalHeight);
//       svgElement.setAttribute("viewBox", `0 0 ${originalWidth} ${originalHeight}`);
//     };

//     image.src = url;
//   });

//   // Initialize when Generate Button is Clicked
//   generateButton.addEventListener("click", function () {
//     let selectedText = "";

//     if (typeof padeditor !== "undefined" && padeditor.ace) {
//       console.log("Calling Ace editor API...");
//       padeditor.ace.callWithAce(
//         (ace) => {
//           const rep = ace.ace_getRep();
//           const selStart = rep.selStart;
//           const selEnd = rep.selEnd;

//           if (selStart && selEnd) {
//             const lines = rep.lines.slice(selStart[0], selEnd[0] + 1);

//             lines.forEach((line, index) => {
//               const startCol = index === 0 ? selStart[1] : 0;
//               const endCol = index === lines.length - 1 ? selEnd[1] : line.text.length;
//               selectedText += line.text.substring(startCol, endCol);

//               if (index < lines.length - 1) {
//                 selectedText += "\n";
//               }
//             });

//             console.log("Selected Text:", selectedText);

//             modal.style.display = "flex";
//             console.log("Modal opened with content.");
//           } else {
//             console.warn("No text selected.");
//           }
//         },
//         "getSelectedText",
//         true
//       );
//     } else {
//       console.error("Etherpad's padeditor or Ace editor is not initialized.");
//     }

//     modal.style.display = "flex";
//     console.log("Mind map generation started.");

//     // Clear previous visualization (if any)
//     d3.select("#graph-visualization svg").remove();

//     const mindmapContainer = document.getElementById("graph-visualization");

//     if (!mindmapContainer) {
//       console.error("Mindmap container not found.");
//       return;
//     }

//     // SVG and Canvas Setup
//     const width = mindmapContainer.clientWidth || 800;
//     const height = mindmapContainer.clientHeight || 600;

//     const svg = d3.select("#graph-visualization").append("svg").attr("width", "100%").attr("height", "100%").attr("viewBox", `0 0 ${width} ${height}`).attr("preserveAspectRatio", "xMidYMid meet").style("cursor", "pointer");

//     const zoomGroup = svg.append("g"); // Group for zooming and panning
//     const linkGroup = zoomGroup.append("g").attr("class", "links");
//     const nodeGroup = zoomGroup.append("g").attr("class", "nodes");

//     const zoomBehavior = d3
//       .zoom()
//       .scaleExtent([0.5, 5]) // Zoom range
//       .on("zoom", (event) => {
//         zoomGroup.attr("transform", event.transform);
//       });

//     svg.call(zoomBehavior);

//     const simulation = d3
//       .forceSimulation(nodes)
//       .force(
//         "link",
//         d3
//           .forceLink(links)
//           .id((d) => d.id)
//           .distance(150)
//       ) // Increase link distance
//       .force("charge", d3.forceManyBody().strength(-300)) // Adjust charge to space nodes apart
//       .force(
//         "collide",
//         d3.forceCollide().radius((d) => Math.max(30, d.text.length * 5) + 10)
//       ) // Avoid overlap
//       .force("center", d3.forceCenter(width / 2, height / 2))
//       .on("tick", ticked);

//     async function fetchFromDatabase() {
//       try {
//         // Adjust URL/endpoint as needed:
//         const baseApiUrl = "https://3897-34-148-194-45.ngrok-free.app";
//         const endpoint = "generate";

//         // Example: You might have user input or default text
//         const response = await fetch(`${baseApiUrl}/${endpoint}`, {
//           method: "POST",
//           headers: { "Content-Type": "application/json" },
//           body: JSON.stringify({ input_text: selectedText }),
//         });

//         if (!response.ok) {
//           throw new Error(`Server error: ${response.status}`);
//         }

//         const data = await response.json();
//         console.log("Parsed JSON Data:", data);
//         // data.response might be: { mindmap: [ {name, subnodes: [] }, ... ] }
//         // Adjust if your backend uses a different key
//         const mindmapRoot = data.response;

//         // Clear previous data
//         nodes.splice(0, nodes.length);
//         links.splice(0, links.length);

//         // Recursively traverse the returned structure
//         if (mindmapRoot && mindmapRoot.mindmap && Array.isArray(mindmapRoot.mindmap)) {
//           mindmapRoot.mindmap.forEach((mindmapNode) => {
//             traverseMindmap(mindmapNode, null);
//           });
//         }

//         // After populating nodes/links, update the visualization
//         const hierarchyData = buildHierarchy(nodes, links);
//         applyTreeLayout(hierarchyData);
//         update(); // Re-render
//       } catch (error) {
//         console.error("Error fetching data from API:", error);
//       }
//     }

//     // Recursive helper to populate `nodes` & `links`
//     function traverseMindmap(nodeData, parentData) {
//       if (!nodeData || !nodeData.name) return;

//       // Add this node if not already present
//       if (!nodes.some((existingNode) => existingNode.id === nodeData.name)) {
//         nodes.push({
//           id: nodeData.name,
//           text: nodeData.name,
//         });
//       }

//       // Add link from parent -> child
//       if (parentData && parentData.name) {
//         links.push({
//           source: parentData.name,
//           target: nodeData.name,
//           type: "HAS_SUBNODE",
//         });
//       }

//       // Recurse on subnodes
//       if (Array.isArray(nodeData.subnodes)) {
//         nodeData.subnodes.forEach((subnode) => traverseMindmap(subnode, nodeData));
//       }
//     }

//     fetchFromDatabase()
//       .then(() => console.log("API fetch completed"))
//       .catch((err) => console.error("Error in fetchFromApi:", err));

//     function buildHierarchy(nodes, links) {
//       const nodeMap = new Map(nodes.map((node) => [node.id, node]));

//       // Ensure each node has a `children` property initialized
//       nodes.forEach((node) => {
//         if (!node.children) {
//           node.children = [];
//         }
//       });

//       // Add children to parent nodes based on links
//       links.forEach((link) => {
//         const parent = nodeMap.get(link.source);
//         const child = nodeMap.get(link.target);

//         if (parent && child) {
//           parent.children.push(child);
//         }
//       });

//       // Identify root nodes (nodes with no incoming links)
//       const allTargets = new Set(links.map((link) => link.target));
//       const rootNodes = nodes.filter((node) => !allTargets.has(node.id));

//       console.log("Root Nodes:", rootNodes);

//       // If no explicit root exists, take the first node as root
//       if (rootNodes.length === 0) {
//         console.warn("No explicit root node found. Using the first node as the root.");
//         return d3.hierarchy(nodeMap.get(nodes[0].id));
//       }

//       // Handle multiple root nodes by creating a virtual root
//       if (rootNodes.length > 1) {
//         const virtualRoot = { id: "virtualRoot", text: "Root", children: rootNodes };
//         const h = d3.hierarchy(virtualRoot);

//         // ✅ Minimal one-line fix: shift every descendant's depth down by 1
//         h.each((n) => {
//           n.depth = Math.max(0, n.depth - 1);
//         });

//         return h;
//       }

//       // Build hierarchy starting from the single root node
//       const hierarchy = d3.hierarchy(nodeMap.get(rootNodes[0].id));

//       // Assign depths to nodes in the hierarchy
//       // Minimal fix: only assign depth if it's null (not set)
//       hierarchy.each((node) => {
//         const dataNode = nodeMap.get(node.data.id);
//         if (dataNode && dataNode.depth == null) {
//           dataNode.depth = node.depth;
//         }
//       });

//       // Handle standalone nodes (nodes without any links)
//       const connectedNodes = new Set(links.flatMap((link) => [link.source, link.target]));
//       const standaloneNodes = nodes.filter((node) => !connectedNodes.has(node.id));

//       standaloneNodes.forEach((node) => {
//         // Only set depth to 0 if it's null/undefined,
//         // i.e. hasn't been assigned by the hierarchy
//         if (node.depth == null) {
//           node.depth = 0;
//           console.log(`Standalone Node Assigned Depth 0: ${node.id}`);
//         }
//       });

//       return hierarchy;
//     }

//     function applyTreeLayout(hierarchyData) {
//       const treeLayout = d3.tree().size([width, height - 100]);
//       const treeData = treeLayout(hierarchyData);

//       treeData.descendants().forEach((d) => {
//         const node = nodes.find((n) => n.id === d.data.id);
//         if (node) {
//           node.x = d.x;
//           node.y = d.y;
//         }
//       });
//     }

//     let selectedLevel = null; // To store the currently selected level
//     const colorMap = {}; // To store custom colors for each level
//     const defaultColorScale = d3.scaleOrdinal(d3.schemeCategory10); // Define color scale at a global level

//     function update() {
//       console.log("Updating visualization...");

//       // Ensure nodeColorMap persists across updates
//       if (!window.nodeColorMap) {
//         window.nodeColorMap = new Map();
//       }

//       // Preserve existing positions
//       const nodePositionMap = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));

//       // Build hierarchy for nodes with links
//       const hierarchyData = buildHierarchy(nodes, links);

//       // Minimal fix: only assign depth if it's null
//       hierarchyData.each((node) => {
//         const dataNode = nodes.find((n) => n.id === node.data.id);
//         if (dataNode && dataNode.depth == null) {
//           dataNode.depth = node.depth;
//           if (!colorMap[node.depth]) {
//             colorMap[node.depth] = defaultColorScale(node.depth);
//           }
//         }
//       });

//       // Assign depth 0 color to standalone nodes and ensure color persistence
//       const rootColor = colorMap[0] || defaultColorScale(0);
//       nodes.forEach((node) => {
//         const isStandalone = !links.some((link) => link.source === node.id || link.target === node.id);

//         if (isStandalone && node.depth === undefined) {
//           node.depth = 0; // Assign root depth if undefined
//         }

//         // Assign color only if not already present in the persistent map
//         if (!window.nodeColorMap.has(node.id)) {
//           const color = isStandalone ? rootColor : colorMap[node.depth] || defaultColorScale(node.depth);
//           window.nodeColorMap.set(node.id, color);
//         }
//       });

//       // Re-check node depth and color
//       nodes.forEach((node) => {
//         const hasLinks = links.some((link) => link.source === node.id || link.target === node.id);
//         if (hasLinks) {
//           if (node.depth === undefined || node.depth === 0) {
//             // Attempt to find correct depth in hierarchy
//             const found = hierarchyData.find((h) => h.data.id === node.id);
//             node.depth = found ? found.depth : 0;
//           }
//         }
//         // Update color
//         const newColor = colorMap[node.depth] || defaultColorScale(node.depth);
//         window.nodeColorMap.set(node.id, newColor);

//         // Force standalone depth 0
//         const isStandalone = !links.some((link) => link.source === node.id || link.target === node.id);
//         if (isStandalone && node.depth == null) {
//           node.depth = 0;
//           const color = colorMap[0] || defaultColorScale(0);
//           window.nodeColorMap.set(node.id, color);
//         }
//       });

//       console.log(
//         "Updated Node Depths:",
//         nodes.map((n) => ({ id: n.id, depth: n.depth }))
//       );
//       console.log("Updated Color Map:", colorMap);

//       // Update Links
//       const link = linkGroup
//         .selectAll("line")
//         .data(links, (d) => `${d.source}-${d.target}`)
//         .join(
//           (enter) => enter.append("line").attr("stroke", "#999").attr("stroke-width", 2),
//           (update) => update,
//           (exit) => exit.remove()
//         );

//       // Update Nodes
//       const node = nodeGroup
//         .selectAll("g")
//         .data(nodes, (d) => d.id)
//         .join(
//           (enter) => {
//             const nodeEnter = enter
//               .append("g")
//               .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended))
//               .on("click", (event, d) => {
//                 selectedLevel = d.depth;
//                 console.log("Selected Level:", selectedLevel);

//                 const colorPickerContainer = document.getElementById("color-picker-container");
//                 const colorPicker = document.getElementById("color-picker");

//                 colorPickerContainer.style.display = "block"; // Show color picker
//                 colorPicker.value = colorMap[selectedLevel] || defaultColorScale(d.depth || 0); // Set to current color
//               })
//               .on("dblclick", (event, d) => {
//                 const input = document.createElement("input");
//                 input.type = "text";
//                 input.value = d.text;
//                 input.style.position = "absolute";
//                 input.style.left = `${event.pageX}px`;
//                 input.style.top = `${event.pageY}px`;
//                 input.style.zIndex = 1000;

//                 document.body.appendChild(input);
//                 input.focus();

//                 // -------------------------------------
//                 //  REMOVE session.run() for rename
//                 // -------------------------------------
//                 input.addEventListener("blur", () => {
//                   const updatedText = input.value.trim();
//                   if (updatedText && updatedText !== d.text) {
//                     // Just update the array + D3 text
//                     d.text = updatedText;
//                     d3.select(event.target.parentNode).select("text").text(updatedText);
//                     console.log("Node updated successfully:", updatedText);
//                   }
//                   document.body.removeChild(input);
//                 });

//                 event.stopPropagation();
//               });

//             nodeEnter
//               .append("ellipse")
//               .attr("rx", (d) => Math.max(30, d.text.length * 5))
//               .attr("ry", 30)
//               .attr("fill", (d) => window.nodeColorMap.get(d.id))
//               .attr("stroke", "#333")
//               .attr("stroke-width", 2);

//             nodeEnter
//               .append("text")
//               .attr("text-anchor", "middle")
//               .attr("alignment-baseline", "middle")
//               .text((d) => d.text);

//             return nodeEnter;
//           },
//           (update) =>
//             update
//               .attr("transform", (d) => {
//                 const position = nodePositionMap.get(d.id);
//                 if (position) {
//                   d.fx = position.x;
//                   d.fy = position.y;
//                   return `translate(${position.x},${position.y})`;
//                 }
//                 return `translate(${d.x},${d.y})`;
//               })
//               .select("ellipse")
//               .attr("fill", (d) => window.nodeColorMap.get(d.id)),
//           (exit) => exit.remove()
//         );

//       // Restart simulation for only new nodes
//       simulation.nodes(nodes);
//       simulation.force("link").links(links);
//       simulation.alpha(1).restart();

//       console.log("Nodes:", nodes);
//       console.log("Links:", links);
//     }

//     // Add Event Listener for Color Picker
//     document.getElementById("color-picker").addEventListener("input", (event) => {
//       const newColor = event.target.value;

//       if (selectedLevel !== null) {
//         // Update the color map for the selected level
//         colorMap[selectedLevel] = newColor;

//         // Re-render nodes with the updated colors
//         nodeGroup
//           .selectAll("g")
//           .select("ellipse")
//           .attr("fill", (d) => colorMap[d.depth] || defaultColorScale(d.depth || 0));
//       }
//     });

//     // Add global click listener to hide the color picker
//     document.addEventListener("click", (event) => {
//       const colorPickerContainer = document.getElementById("color-picker-container");
//       colorPickerContainer.style.display = "none"; // Hide color picker
//     });

//     // Prevent hiding when clicking on a node
//     nodeGroup.on("click", (event) => {
//       event.stopPropagation(); // Prevent the global click event from triggering
//     });

//     function ticked() {
//       linkGroup
//         .selectAll("line")
//         .attr("x1", (d) => calculateEdgePosition(d.source, d.target).x1)
//         .attr("y1", (d) => calculateEdgePosition(d.source, d.target).y1)
//         .attr("x2", (d) => calculateEdgePosition(d.source, d.target).x2)
//         .attr("y2", (d) => calculateEdgePosition(d.source, d.target).y2);

//       nodeGroup.selectAll("g").attr("transform", (d) => `translate(${d.x},${d.y})`);
//     }

//     function calculateEdgePosition(source, target) {
//       // Dimensions for source and target ellipses
//       const sourceRx = Math.max(30, source.text.length * 5);
//       const sourceRy = 30;
//       const targetRx = Math.max(30, target.text.length * 5);
//       const targetRy = 30;

//       // Parent connects to bottom-middle
//       const sourceX = source.x;
//       const sourceY = source.y + sourceRy;

//       // Child connects to top-middle
//       const targetX = target.x;
//       const targetY = target.y - targetRy;

//       return {
//         x1: sourceX,
//         y1: sourceY,
//         x2: targetX,
//         y2: targetY,
//       };
//     }

//     function dragstarted(event, d) {
//       // Stop the simulation for all nodes to allow independent movement
//       simulation.alpha(0).stop();
//       d.fx = d.x;
//       d.fy = d.y;
//     }

//     function dragged(event, d) {
//       d.fx = event.x;
//       d.fy = event.y;

//       // Update the dragged node's position in the nodes array
//       nodes.forEach((node) => {
//         if (node.id === d.id) {
//           node.x = d.fx;
//           node.y = d.fy;
//         }
//       });

//       // Update the dragged node's position visually
//       nodeGroup
//         .selectAll("g")
//         .filter((node) => node.id === d.id)
//         .attr("transform", `translate(${d.fx},${d.fy})`);

//       // Dynamically update only the links connected to the dragged node
//       linkGroup
//         .selectAll("line")
//         .filter((line) => line.source.id === d.id || line.target.id === d.id)
//         .attr("x1", (line) => {
//           return line.source.id === d.id ? d.fx : line.source.x;
//         })
//         .attr("y1", (line) => {
//           return line.source.id === d.id ? d.fy : line.source.y;
//         })
//         .attr("x2", (line) => {
//           return line.target.id === d.id ? d.fx : line.target.x;
//         })
//         .attr("y2", (line) => {
//           return line.target.id === d.id ? d.fy : line.target.y;
//         });
//     }

//     function dragended(event, d) {
//       // Release the dragged node and allow it to stay in the final position
//       d.fx = null;
//       d.fy = null;
//     }

//     // Add event listener for "Add Node" button
//     if (!isAddNodeListenerAttached) {
//       addNode.addEventListener("click", function handleAddNodeClick() {
//         const newNodeName = document.getElementById("new-node-name").value.trim();

//         if (!newNodeName) {
//           console.error("Node name cannot be empty.");
//           alert("Please enter a valid node name.");
//           return;
//         }

//         // Disable the button to prevent multiple submissions
//         addNode.disabled = true;

//         // Check if the node already exists
//         console.log("Current nodes array:", nodes);
//         if (nodes.some((node) => node.id === newNodeName)) {
//           console.error("Node with this name already exists.");
//           alert("A node with this name already exists. Please use a different name.");
//           addNode.disabled = false;
//           return;
//         }

//         // -------------------------------------
//         //  REMOVED DB creation step
//         // -------------------------------------

//         console.log(`Node '${newNodeName}' added (in-memory only).`);

//         // Add the new node to the visualization arrays
//         const newNode = {
//           id: newNodeName,
//           text: newNodeName,
//           // Set a default position based on existing nodes
//           x:
//             nodes.length > 0
//               ? d3.mean(nodes, (node) => node.x) || 400
//               : 400,
//           y:
//             nodes.length > 0
//               ? d3.mean(nodes, (node) => node.y) || 300
//               : 300,
//           depth: null, // until hierarchy is recalculated
//         };

//         nodes.push(newNode);

//         update();
//         console.log(`Node '${newNodeName}' added to the visualization.`);

//         addNode.disabled = false;
//         document.getElementById("new-node-name").value = "";
//       });

//       isAddNodeListenerAttached = true;
//     }

//     addRelation.addEventListener("click", function () {
//       const sourceName = document.getElementById("add-relation-source").value.trim();
//       const targetName = document.getElementById("add-relation-target").value.trim();

//       if (!sourceName || !targetName) {
//         alert("Please enter both source and target node names.");
//         return;
//       }

//       if (sourceName === targetName) {
//         alert("Source and target nodes cannot be the same.");
//         return;
//       }

//       // Check if both nodes exist
//       const sourceNode = nodes.find((node) => node.id === sourceName);
//       const targetNode = nodes.find((node) => node.id === targetName);

//       if (!sourceNode || !targetNode) {
//         alert("One or both nodes do not exist. Please enter valid node names.");
//         return;
//       }

//       // -------------------------------------
//       //  REMOVED DB relation creation
//       // -------------------------------------
//       console.log(`✅ Relation added (in arrays): ${sourceName} → ${targetName}`);

//       links.push({ source: sourceName, target: targetName, type: "HAS_SUBNODE" });
//       update(); // Refresh visualization

//       document.getElementById("add-relation-source").value = "";
//       document.getElementById("add-relation-target").value = "";
//     });

//   });
// });

$(document).ready(function () {
  console.log("Custom image detection script loaded.");

  // Function to detect images, alt text, and filenames
  function logImages() {
    const images = document.querySelectorAll("iframe[name='ace_outer']")[0].contentDocument.querySelector("iframe[name='ace_inner']").contentDocument.querySelectorAll("img"); // Get images inside the pad

    const imageDetails = Array.from(images).map((img) => ({
      src: img.src,
      alt: img.alt || "No alt text", // If alt is empty, return "No alt text"
      filename: img.src.split("/").pop(), // Extract the filename from the URL
    }));

    console.log("🖼️ Detected Image Details:", imageDetails);
    console.log("📊 Total Image Count:", imageDetails.length);
  }

  // Add a click event listener to the 'Calculate' button
  $("#calculate-images").on("click", logImages);
});
