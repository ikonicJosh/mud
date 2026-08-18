/**
 * LinkedIn DOM selectors, in one file.
 *
 * LinkedIn ships UI changes constantly and these will rot. That's the reason
 * they're centralised: when the agent starts failing, this is the only file to
 * look at, and `health.ts` turns a vanished selector into a circuit-breaker trip
 * rather than into silently doing nothing (or worse, clicking the wrong thing).
 *
 * Each entry lists fallbacks in preference order — LinkedIn A/B tests layouts,
 * so more than one can be live at once.
 */

export const SELECTORS = {
  /** Present on any authenticated page. Absence means the session is dead. */
  authMarker: [
    'nav.global-nav',
    '#global-nav',
    '[data-test-global-nav]',
    'header.global-nav',
  ],

  feed: {
    post: ['div.feed-shared-update-v2', 'div[data-urn*="activity"]', 'div[data-id*="urn:li:activity"]'],
    postUrn: ['data-urn', 'data-id'],
    postBody: [
      '.feed-shared-update-v2__description',
      '.update-components-text',
      '.feed-shared-inline-show-more-text',
    ],
    postAuthorLink: [
      '.update-components-actor__meta a',
      '.feed-shared-actor__container-link',
      'a.update-components-actor__meta-link',
    ],
    postAuthorName: ['.update-components-actor__title', '.feed-shared-actor__name'],
    likeButton: [
      'button[aria-label^="React Like"]',
      'button.react-button__trigger',
      'button[aria-label*="Like"][type="button"]',
    ],
    commentButton: ['button[aria-label^="Comment"]', 'button.comment-button'],
    commentBox: [
      'div.ql-editor[contenteditable="true"]',
      'div[data-placeholder="Add a comment…"]',
      '.comments-comment-box__form div[role="textbox"]',
    ],
    commentSubmit: ['button.comments-comment-box__submit-button', 'button[type="submit"].comments-comment-box__submit-button--cr'],
    commenterLinks: ['article.comments-comment-entity a.comments-post-meta__actor-link', '.comments-post-meta__name-text'],
  },

  profile: {
    name: ['h1.text-heading-xlarge', 'h1.inline.t-24', 'main h1'],
    headline: ['div.text-body-medium.break-words', '.pv-text-details__left-panel .text-body-medium'],
    location: ['span.text-body-small.inline.t-black--light.break-words'],
    currentCompany: [
      'button[aria-label^="Current company"] span',
      '.pv-text-details__right-panel-item-text',
      'div.inline-show-more-text',
    ],
    connectButton: [
      'button[aria-label^="Invite"][aria-label*="connect"]',
      'main button.artdeco-button--primary:has-text("Connect")',
      'div.pvs-profile-actions button:has-text("Connect")',
    ],
    moreButton: ['button[aria-label="More actions"]', 'button.artdeco-dropdown__trigger'],
    /** In the connect modal. */
    addNoteButton: ['button[aria-label="Add a note"]'],
    noteTextarea: ['textarea#custom-message', 'textarea[name="message"]'],
    sendInviteButton: ['button[aria-label="Send invitation"]', 'button[aria-label="Send now"]'],
    messageButton: ['button[aria-label^="Message"]', 'a[href*="/messaging/thread/"]'],
    activityFeedLink: ['a[href*="/recent-activity/"]'],
  },

  messaging: {
    conversationItem: ['li.msg-conversation-listitem', 'li.msg-conversations-container__convo-item'],
    conversationLink: ['a.msg-conversation-listitem__link'],
    conversationUnread: ['.msg-conversation-card--unread', '[data-test-unread]'],
    participantName: ['.msg-conversation-listitem__participant-names', 'h2.msg-entity-lockup__entity-title'],
    messageBubble: ['li.msg-s-message-list__event', '.msg-s-event-listitem'],
    messageSender: ['.msg-s-message-group__name', '.msg-s-message-group__profile-link'],
    messageBody: ['.msg-s-event-listitem__body', 'p.msg-s-event-listitem__body'],
    messageTimestamp: ['time.msg-s-message-group__timestamp', '.msg-s-message-group__timestamp'],
    composeBox: ['div.msg-form__contenteditable[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
    sendButton: ['button.msg-form__send-button', 'button[type="submit"].msg-form__send-btn'],
  },

  search: {
    resultItem: ['li.reusable-search__result-container', 'div.search-results-container li'],
    resultLink: ['a.app-aware-link[href*="/in/"]', 'span.entity-result__title-text a'],
    resultName: ['span.entity-result__title-text span[aria-hidden="true"]'],
    resultHeadline: ['div.entity-result__primary-subtitle'],
    resultLocation: ['div.entity-result__secondary-subtitle'],
    nextPage: ['button[aria-label="Next"]'],
  },
} as const;

/** Join a fallback list into one CSS selector Playwright can use. */
export function anyOf(candidates: readonly string[]): string {
  return candidates.join(', ');
}

/** Extract the LinkedIn public id from a profile URL. */
export function publicIdFromUrl(url: string): string | null {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
