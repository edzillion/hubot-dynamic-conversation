var series = require('async-series');
var util = require('util');
var EventEmitter = require('events');

/**
 * Starts a new dialog with a user
 * @param {Conversation} switchBoard
 * @param {Hubot.Response} msg
 * @param {Array} messageOptions - refer to docs in index.js `Conversation.prototype.start`
 * @api private
 */
function Dialog(switchBoard, msg, messageOptions, robot) {
  EventEmitter.call(this);
  this.dialog = switchBoard.startDialog(msg, Dialog.TIMEOUT);
  this.msg = msg;
  this.messageOptions = messageOptions;
  this.robot = robot;

  this.data = {
    source: '',
    dateTime: null,
    answers: [],
    aborted: false,
    skipped: []
  };

  this.data.source = msg.envelope.user;
  this.data.robot = { name: robot.name, alias: robot.alias };
}
util.inherits(Dialog, EventEmitter);

/**
 * Strip the bot's name from the description text
 * @param  {String} text
 * @return {String}
 * Implemented from https://github.com/timkinnane/hubot-rocketchat-announcement/blob/master/src/rocketchat-announcement.coffee#L46-L54
 */
Dialog.prototype._stripBotName = function (text) {
  var nameStart = text.charAt(0) === '@' ? 1 : 0;
  var nameStrip;

  if (text.indexOf(this.robot.name) === nameStart) nameStrip = this.robot.name;
  else if (text.indexOf(this.robot.alias) === nameStart) nameStrip = this.robot.alias;
  else if (text.indexOf('Hubot') === nameStart) nameStrip = 'Hubot';
  else if (text.indexOf('hubot') === nameStart) nameStrip = 'hubot';
  
  var len = (nameStrip === undefined) ? 0 : nameStart + nameStrip.length;

  // handle situations where someone answers a question with the bot name, which could legitimately happen
  if (nameStrip && text.length == nameStrip.length)
    return text;

  if (text.charAt(len) === ':') len += 1;

  return text.substring(len).trim();
};


/**
 * Invoke a dialog message with the user and collect the response into the data
 * @param  {Object}   message It holds the message model
 * eg. {
 *       question: 'Do you have any trouble',
 *       answer: {
 *         type: 'text'
 *       },
 *       required: false,
 *       error: 'Sorry, did not understand response'
 *     }
 * @param  {Function} done    The function provided by async-series to call the next dialog message
 * @return {null}
 * @api private
 */
Dialog.prototype._invokeDialog = function (message, done) {
  var self = this;

  if (message.dynamic) {
    
    var dynamicChoice = self.data.answers[message.fromQuestionIndex].response.value;
    var dynamicQuestions = message[dynamicChoice];
    
    if (dynamicQuestions instanceof Array) {
      var seriesCallbacks = [];  
      for (var i = 0; i < dynamicQuestions.length; i++) {
        (function (currIndex) {
          var dynaQ = dynamicQuestions[currIndex];
          seriesCallbacks.push(function (done) {
            self._invokeDialog(dynaQ, done);
          });
        })(i);
      }

      series(seriesCallbacks, function (res) {     
        done();
      });
    }
    else {
      self._invokeDialog(dynamicQuestions, done);
    }
    return;
  }

  var question = message.question.trim();
  var code = question.charCodeAt(question.length - 1);

  if (!message.required) {
    question = ((code === 46 || code === 63) ? question : question + '.') + ' Reply with [skip] to move to the next question.';
  }

  function updateAnswers(key, value) {
    var currAnswer = {
      question: message.question,
      response: {
        type: message.answer.type
      }
    };

    currAnswer.response[key] = value;
    self.data.answers.push(currAnswer);
  }

  self.msg.reply(question);

  if (!message.required) {
    self.dialog.addChoice(/skip/i, function (dialogMessage) {
      dialogMessage.reply('Ok. we are skipping this section.');
      updateAnswers('value', self._stripBotName(dialogMessage.message.text));
      self.msg = dialogMessage;
      done();
    });
  }

  if (self.messageOptions.abortKeyword) {
   self.dialog.addChoice(this.messageOptions.abortKeyword, function (dialogMessage) {
      self.msg = dialogMessage;
      self.data.aborted = true;

      if (self.messageOptions.onAbortMessage)
        self.msg.reply(self.messageOptions.onAbortMessage);

      done(new Error('Aborted'));
    });
  }

  if (message.answer.type === 'choice') {
    for (var j = 0, len = message.answer.options.length; j < len; j++) {
      (function choiceRunner(choiceIndex) {
        var option = message.answer.options[choiceIndex];

        self.dialog.addChoice(option.match, function (dialogMessage) {
          dialogMessage.reply(option.response);
          updateAnswers('value', self._stripBotName(dialogMessage.message.text));

          if (!option.valid) {
            return done(new Error('User provided an invalid response'));
          }

          self.msg = dialogMessage;
          done();
        });
      })(j);
    }

    self.dialog.addChoice(/(.*)/i, function (dialogMessage) {
      dialogMessage.reply(message.error);
      self.msg = dialogMessage;
      self._invokeDialog(message, done);
    });
  }

  if (message.answer.type === 'text') {
    self.dialog.addChoice(/^(?!\s*$).+/i, function (dialogMessage) {
      updateAnswers('value', self._stripBotName(dialogMessage.message.text));
      self.msg = dialogMessage;
      done();
    });
  }

  if (message.answer.type === 'series') {
    self.dialog.addChoice(/([2-9])/i, function (dialogMessage) {
      
      var answer = self._stripBotName(dialogMessage.message.text);
      updateAnswers('value', answer);
      var numOptions = Number(answer);
      var firstLetter = 'A'; 
      var seriesQuestions = [];  

      for (var i=0, charCode=firstLetter.charCodeAt(0); i<numOptions; i++, charCode++) {
        seriesQuestions.push(
          {
            question: "Enter option "+String.fromCharCode(charCode)+":",
            answer: {
              type: "text"
            },
            required: true
          }
        );  
      }

      var seriesCallbacks = [];  
      for (var i = 0; i < seriesQuestions.length; i++) {
        (function (currIndex) {
          var seriesQ = seriesQuestions[currIndex];
          seriesCallbacks.push(function (done) {
            self._invokeDialog(seriesQ, done);
          });
        })(i);
      }

      series(seriesCallbacks, function (res) {     
        done();
      });
    });

    self.dialog.addChoice(/(.*)/i, function (dialogMessage) {
      dialogMessage.reply(message.error);
      self.msg = dialogMessage;
      self._invokeDialog(message, done);
    });
  }

  if (message.answer.type === 'attachment') {
    self.dialog.addChoice(/.*/, function (dialogMessage) {
      if (dialogMessage.message.attachment && dialogMessage.message.attachment.type === 'image') {
        updateAnswers('link', dialogMessage.message.attachment.link);
        self.msg = dialogMessage;
        return done();
      }

      if (message.required) {
        dialogMessage.reply(message.error);
        return self._invokeDialog(message, done);
      }

      dialogMessage.reply(message.error);
      done();
    });
  }
};

/**
 * Gets the data for the dialog
 * @return {Object} The object that describes the dialog
 * @api public
 */
Dialog.prototype.fetch = function () {
  return this.data;
};


/**
 * Starts the dialog with the user
 * @return {null}
 * @api public
 */
Dialog.prototype.start = function () {
  var self = this;
  var cbs = [];

  // set all the dialog messages as callback functions that will be run in series
  // that means the next question won't be asked until the previous one has been
  // dealt with
  for (var i = 0, l = self.messageOptions.conversation.length; i < l; i++) {
    (function (currIndex) {
      var message = self.messageOptions.conversation[currIndex];
      cbs.push(function (done) {
        self._invokeDialog(message, done);
      });
    })(i);
  }

  if (self.messageOptions.abortKeyword) self.msg.reply('You can cancel this conversation with [' + self.messageOptions.abortKeyword + '].');
  // call the callbacks in series
  // emit 'end' when all is done or an error occurs
  series(cbs, function (res) {
    self.data.dateTime = new Date();

    if (!self.data.aborted && self.messageOptions.onCompleteMessage)
      self.msg.reply(self.messageOptions.onCompleteMessage);

    return self.emit('end', res, self.msg);
  });
};



Dialog.TIMEOUT = 500 * 1000;

/**
 * Module exports
 * @type {Dialog}
 * @public
 */
module.exports = Dialog;
