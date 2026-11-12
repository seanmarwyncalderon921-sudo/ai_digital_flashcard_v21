/* Firebase is loaded with the compat build so the existing single-page app can
 * use one small service boundary instead of spreading SDK calls throughout UI code. */
(function initialiseFirebaseServices() {
  const config = window.SAPC_FIREBASE_CONFIG;
  const isConfigured = config && !Object.values(config).some(value => String(value).startsWith("REPLACE_WITH"));

  if (!isConfigured || !window.firebase) {
    window.sapcFirebase = {
      configured: false,
      getCurrentUser: () => null,
      getIdToken: async () => null,
      ensureChatIdentity: async () => { throw new Error("User must be signed in to chat."); },
      ensureChatConversation: async () => null,
      createGroupConversation: async () => { throw new Error("Group chat service not configured."); },
      listGroupConversations: async () => [],
      subscribeToChatMessages: () => () => {},
      sendChatMessage: async () => { throw new Error("Chat service not configured."); },
      listChatMessages: async () => [],
      deleteChatConversation: async () => { throw new Error("Chat service not configured."); },
      unsendChatMessage: async () => { throw new Error("Chat service not configured."); },
      markChatMessagesSeen: async () => {},
      uploadChatAttachment: async () => { throw new Error("Attachment upload not configured."); },
      uploadChatConversationAttachment: async () => { throw new Error("Attachment upload not configured."); },
      fetchChatAttachment: async () => { throw new Error("Attachment download not configured."); },
      deleteChatAttachment: async () => { throw new Error("Attachment deletion not configured."); }
    };
    return;
  }

  firebase.initializeApp(config);
  const auth = firebase.auth();
  const db = firebase.firestore();

  // Enable offline persistence for instantaneous local message loading
  db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
    if (err.code == 'failed-precondition') {
      console.warn("Persistence failed: Multiple browser tabs open.");
    } else if (err.code == 'unimplemented') {
      console.warn("Persistence is not supported by this browser.");
    }
  });

  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const profileRef = user => db.collection("users").doc(user.uid);
  const deckCollection = user => profileRef(user).collection("decks");
  const publicProfileRef = uid => db.collection("publicProfiles").doc(uid);
  const getRecipientId = profile => profile?.id || profile?.uid || profile || "";
  const visibleAccountName = (...values) => values.map(value => String(value || "").trim().replace(/@.*$/, ""))
    .find(Boolean) || "Paduan";

  async function ensureProfile(user) {
    const ref = profileRef(user);
    const snapshot = await ref.get();
    const existing = snapshot.exists ? snapshot.data() : {};
    const profile = {
      email: user.email || existing.email || "",
      displayName: existing.displayName || user.displayName || user.email?.split("@")[0] || "Paduan",
      username: existing.username || "",
      photoURL: existing.photoURL || user.photoURL || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!snapshot.exists) profile.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(profile, { merge: true });
    await publicProfileRef(user.uid).set({
      displayName: profile.displayName,
      displayNameLower: String(profile.displayName || "").toLowerCase(),
      email: profile.email,
      username: profile.username,
      usernameLower: String(profile.username || "").toLowerCase(),
      photoURL: profile.photoURL,
      lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
      gradeLevel: existing.gradeLevel || "",
      strand: existing.strand || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ...existing, ...profile };
  }

  async function saveDeck(user, deck) {
    const ref = deck.id ? deckCollection(user).doc(deck.id) : deckCollection(user).doc();
    const payload = {
      title: String(deck.title || "Saved Reviewer Deck").trim().slice(0, 120),
      subjectMode: deck.subjectMode || "general",
      gradeLevel: deck.gradeLevel || "Grade 11",
      academicStrand: deck.academicStrand || "General",
      tags: Array.isArray(deck.tags) ? deck.tags.slice(0, 20) : [],
      cards: Array.isArray(deck.cards) ? deck.cards : [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!deck.id) payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await ref.set(payload, { merge: true });
    return { id: ref.id, ...payload };
  }

  async function recordStudySession(user, data) {
    const session = {
      deckId: data.deckId || "local-session",
      correct: Number(data.correct) || 0,
      total: Number(data.total) || 0,
      durationSeconds: Number(data.durationSeconds) || 0,
      completedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await profileRef(user).collection("studySessions").add(session);
    await profileRef(user).set({
      lastStudiedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  window.sapcFirebase = {
    configured: true,
    auth,
    db,
    provider,
    getCurrentUser: () => auth.currentUser,
    getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : null,

    ensureChatIdentity: async () => {
      const user = auth.currentUser;
      if (!user) {
        throw new Error("User must be signed in to chat.");
      }
      const token = await user.getIdToken(true);
      return {
        userId: user.uid,
        token: token
      };
    },

    ensureChatConversation: async (userOrRecipient, profileOrNull) => {
      const user = auth.currentUser || (userOrRecipient && userOrRecipient.uid ? userOrRecipient : null);
      const recipientId = getRecipientId(profileOrNull || userOrRecipient);
      if (!user || !recipientId) return null;

      const participants = [String(user.uid), String(recipientId)].sort();
      const conversationId = `chat:${participants.join(":")}`;
      const convRef = db.collection("chatConversations").doc(conversationId);
      const snapshot = await convRef.get();
      if (!snapshot.exists) {
        await convRef.set({
          participants: participants,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
      return conversationId;
    },

    createGroupConversation: async (user, friends, title) => {
      const currentUser = auth.currentUser || user;
      if (!currentUser) throw new Error("Sign in to create a group chat.");
      const selected = [...new Map((friends || []).map(friend => [String(getRecipientId(friend)), friend])).values()];
      if (selected.length < 2 || selected.length > 19 || selected.some(friend => !getRecipientId(friend) || String(getRecipientId(friend)) === currentUser.uid)) {
        throw new Error("Choose between 2 and 19 friends for a group chat.");
      }
      const requestSnapshot = await db.collection("friendRequests")
        .where("participants", "array-contains", currentUser.uid).limit(100).get();
      const accepted = new Set();
      requestSnapshot.docs.forEach(doc => {
        const data = doc.data();
        if (data.status === "accepted") accepted.add(data.fromId === currentUser.uid ? data.toId : data.fromId);
      });
      if (selected.some(friend => !accepted.has(String(getRecipientId(friend))))) {
        throw new Error("Group chats can include accepted friends only. Refresh your friends list and try again.");
      }
      const members = [{ id: currentUser.uid, displayName: currentUser.displayName || currentUser.email?.split("@")[0] || "Paduan", photoURL: currentUser.photoURL || "" }, ...selected.map(friend => ({
        id: String(getRecipientId(friend)), displayName: String(friend.displayName || friend.username || "Paduan").slice(0, 80), photoURL: String(friend.photoURL || "")
      }))];
      const ref = db.collection("chatConversations").doc();
      const conversationId = `group:${ref.id}`;
      const conversationRef = db.collection("chatConversations").doc(conversationId);
      const data = {
        type: "group", title: String(title || "").trim().slice(0, 60) || "Study group", createdBy: currentUser.uid,
        participants: members.map(member => member.id).sort(), members,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await conversationRef.set(data);
      return { id: conversationId, conversationId, ...data };
    },

    listGroupConversations: async user => {
      if (!user) return [];
      const snapshot = await db.collection("chatConversations").where("participants", "array-contains", user.uid).limit(100).get();
      return snapshot.docs.map(doc => ({ id: doc.id, conversationId: doc.id, ...doc.data() }))
        .filter(conversation => conversation.type === "group")
        .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
    },

    subscribeToChatMessages: (arg1, arg2, arg3) => {
      let conversationId = "";
      let callback = null;

      if (typeof arg1 === 'string' && (arg1.startsWith('chat:') || arg1.startsWith('group:'))) {
        conversationId = arg1;
        callback = arg2;
      } else {
        const user = arg1;
        const profile = arg2;
        callback = arg3;
        const recipientId = getRecipientId(profile);
        if (!user || !recipientId) return () => {};
        const participants = [String(user.uid), String(recipientId)].sort();
        conversationId = `chat:${participants.join(":")}`;
      }

      if (!conversationId || typeof callback !== "function") return () => {};
      return db.collection("chatConversations")
        .doc(conversationId)
        .collection("messages")
        .orderBy("timestamp", "desc")
        .limit(100)
        .onSnapshot(snapshot => {
          const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();
          callback(messages);
        }, error => {
          console.error("Error subscribing to chat messages:", error);
        });
    },

    listChatMessages: async (user, profile) => {
      const conversationId = typeof profile === "string" ? profile : (profile?.conversationId || profile?.id || (getRecipientId(profile) ? `chat:${[String(user?.uid), String(getRecipientId(profile))].sort().join(":")}` : ""));
      if (!user || !conversationId) return [];
      const snapshot = await db.collection("chatConversations")
        .doc(conversationId)
        .collection("messages")
        .orderBy("timestamp", "desc")
        .limit(100)
        .get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).reverse();
    },

    deleteChatConversation: async (user, profile) => {
      const conversationId = typeof profile === "string" ? profile : (profile?.conversationId || profile?.id || (getRecipientId(profile) ? `chat:${[String(user?.uid), String(getRecipientId(profile))].sort().join(":")}` : ""));
      if (!user || !conversationId) throw new Error("A chat conversation is required.");
      const conversationRef = db.collection("chatConversations").doc(conversationId);
      const messagesRef = conversationRef.collection("messages");
      const serverAttachments = [];
      while (true) {
        const snapshot = await messagesRef.limit(400).get();
        if (snapshot.empty) break;
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
          const message = doc.data();
          const attachments = Array.isArray(message.attachments) ? message.attachments : (message.attachment ? [message.attachment] : []);
          serverAttachments.push(...attachments.filter(item => item.storage === "server"));
          batch.delete(doc.ref);
        });
        await batch.commit();
      }
      await Promise.allSettled(serverAttachments.map(item => window.sapcFirebase.deleteChatAttachment(user, item)));
      await conversationRef.delete();
    },

    markChatMessagesSeen: async (user, profile, messages) => {
      const conversationId = typeof profile === "string" ? profile : (profile?.conversationId || profile?.id || (getRecipientId(profile) ? `chat:${[String(user?.uid), String(getRecipientId(profile))].sort().join(":")}` : ""));
      if (!user || !conversationId || !Array.isArray(messages)) return;
      const batch = db.batch();
      let count = 0;
      messages.forEach(msg => {
        if (msg.senderId !== user.uid && (!msg.seenBy || !msg.seenBy[user.uid])) {
          const ref = db.collection("chatConversations").doc(conversationId).collection("messages").doc(msg.id);
          batch.update(ref, { [`seenBy.${user.uid}`]: firebase.firestore.FieldValue.serverTimestamp() });
          count++;
        }
      });
      if (count > 0) {
        await batch.commit();
      }
    },

    uploadChatAttachment: async (user, file) => {
      throw new Error("A conversation must be selected before uploading an attachment.");
    },

    uploadChatConversationAttachment: async (user, conversationId, file) => {
      if (!user || !conversationId || !file) throw new Error("Choose a file and a chat first.");
      const token = await user.getIdToken();
      const apiBase = String(window.SAPC_API_BASE_URL || "").replace(/\/+$/, "");
      const response = await fetch(`${apiBase}/api/chat/attachments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": file.type || "application/octet-stream",
          "X-Chat-Conversation": conversationId,
          "X-File-Name": encodeURIComponent(file.name || "attachment")
        },
        body: file
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Upload failed (${response.status}).`);
      return {
        id: result.id,
        name: result.name || file.name || "attachment",
        mimeType: result.mimeType || file.type || "application/octet-stream",
        size: result.size || file.size,
        url: `${apiBase}/api/chat/attachments/${encodeURIComponent(result.id)}`,
        storage: "server"
      };
    },

    fetchChatAttachment: async (user, attachment) => {
      if (!user || !attachment?.url) throw new Error("This attachment is unavailable.");
      if (String(attachment.url).startsWith("blob:") || String(attachment.url).startsWith("data:")) return attachment.url;
      const token = await user.getIdToken();
      const response = await fetch(attachment.url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Could not load this attachment.");
      }
      return URL.createObjectURL(await response.blob());
    },

    deleteChatAttachment: async (user, attachment) => {
      if (!user || !attachment?.id) return;
      const token = await user.getIdToken();
      const apiBase = String(window.SAPC_API_BASE_URL || "").replace(/\/+$/, "");
      const response = await fetch(`${apiBase}/api/chat/attachments/${encodeURIComponent(attachment.id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok && response.status !== 404) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Could not delete attachment storage.");
      }
    },

    sendChatMessage: async (userOrConvId, profileOrText, messageData) => {
      const user = auth.currentUser || (userOrConvId && userOrConvId.uid ? userOrConvId : null);
      let conversationId = "";
      let text = "";
      let attachments = [];
      let replyTo = null;

      if (typeof userOrConvId === 'string' && (userOrConvId.startsWith('chat:') || userOrConvId.startsWith('group:'))) {
        conversationId = userOrConvId;
        if (profileOrText && typeof profileOrText === "object" && !Array.isArray(profileOrText)) {
          text = profileOrText.text || "";
          attachments = Array.isArray(profileOrText.attachments) ? profileOrText.attachments : [];
          replyTo = profileOrText.replyTo || null;
        } else {
          text = profileOrText;
          attachments = Array.isArray(messageData) ? messageData : (messageData ? [messageData] : []);
        }
      } else {
        const profile = profileOrText;
        const recipientId = getRecipientId(profile);
        if (!user || !recipientId) throw new Error("Invalid chat parameters.");
        const participants = [String(user.uid), String(recipientId)].sort();
        conversationId = `chat:${participants.join(":")}`;
        text = messageData?.text || "";
        attachments = Array.isArray(messageData?.attachments) ? messageData.attachments : (messageData?.attachment ? [messageData.attachment] : []);
        replyTo = messageData?.replyTo || null;
      }

      const payload = {
        senderId: user.uid,
        text: String(text || "").trim().slice(0, 2000),
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        isUnsent: false,
        seenBy: { [user.uid]: firebase.firestore.FieldValue.serverTimestamp() }
      };
      if (attachments.length) {
        payload.attachments = attachments.slice(0, 10);
        payload.attachment = payload.attachments[0];
      }
      if (replyTo?.messageId && replyTo?.text) {
        payload.replyTo = {
          messageId: String(replyTo.messageId).slice(0, 160),
          senderId: String(replyTo.senderId || "").slice(0, 160),
          text: String(replyTo.text).trim().slice(0, 240)
        };
      }

      const msgRef = db.collection("chatConversations").doc(conversationId).collection("messages").doc();
      await msgRef.set(payload);
      await Promise.allSettled(attachments.filter(item => item.storage === "server").map(async item => {
        const token = await user.getIdToken();
        const apiBase = String(window.SAPC_API_BASE_URL || "").replace(/\/+$/, "");
        const response = await fetch(`${apiBase}/api/chat/attachments/${encodeURIComponent(item.id)}/retain`, {
          method: "POST", headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error("Attachment retention could not be confirmed.");
      }));

      try {
        await db.collection("chatConversations").doc(conversationId).set({
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (error) {
        console.warn("Message sent, but conversation timestamp did not refresh:", error.message);
      }

      return { id: msgRef.id, ...payload };
    },

    unsendChatMessage: async (user, conversationId, messageId) => {
      if (!user || !conversationId || !messageId) throw new Error("Could not identify this message.");
      const messageRef = db.collection("chatConversations").doc(conversationId).collection("messages").doc(messageId);
      const snapshot = await messageRef.get();
      const data = snapshot.exists ? snapshot.data() : {};
      const attachments = Array.isArray(data.attachments) ? data.attachments : (data.attachment ? [data.attachment] : []);
      await messageRef.update({
        text: "This message was unsent.", attachments: [], attachment: null, isUnsent: true,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await Promise.allSettled(attachments.filter(item => item.storage === "server").map(item => window.sapcFirebase.deleteChatAttachment(user, item)));
    },

    ensureProfile,
    updatePresence: user => publicProfileRef(user.uid).set({
      lastSeenAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true }),
    signIn: (email, password) => auth.signInWithEmailAndPassword(email, password),
    resolveLoginEmail: async identifier => {
      const value = String(identifier || "").trim().toLowerCase();
      if (value.includes("@")) return value;
      const snapshot = await db.collection("publicProfiles")
        .where("usernameLower", "==", value)
        .limit(1)
        .get();
      if (snapshot.empty) throw new Error("No account was found with that username.");
      return snapshot.docs[0].data().email;
    },
    isUsernameAvailable: async username => {
      const snapshot = await db.collection("publicProfiles")
        .where("usernameLower", "==", String(username || "").trim().toLowerCase())
        .limit(1)
        .get();
      return snapshot.empty;
    },
    register: (email, password) => auth.createUserWithEmailAndPassword(email, password),
    signInWithGoogle: () => auth.signInWithPopup(provider),
      signInWithGoogleRedirect: () => auth.signInWithRedirect(provider),
      completeGoogleRedirect: () => auth.getRedirectResult(),
    linkGoogle: user => user.linkWithPopup(provider),
    sendPasswordReset: email => auth.sendPasswordResetEmail(email, {
      url: "https://ai-driven-academic-flashcards.web.app/reset-password.html",
      handleCodeInApp: false
    }),
    signOut: () => auth.signOut(),
    listDecks: async user => {
      const snapshot = await deckCollection(user).orderBy("updatedAt", "desc").limit(100).get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },
    saveDeck,
    deleteDeck: (user, deckId) => deckCollection(user).doc(deckId).delete(),
    recordStudySession,
    saveProfile: async (user, profile) => {
      const safeProfile = {
        displayName: String(profile.displayName || "").trim().slice(0, 80),
        username: String(profile.username || "").trim().toLowerCase().slice(0, 24),
        bio: String(profile.bio || "").trim().slice(0, 300),
        gradeLevel: String(profile.gradeLevel || "").slice(0, 30),
        strand: String(profile.strand || "").slice(0, 50),
        photoURL: String(profile.photoURL || "").slice(0, 400000),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await profileRef(user).set(safeProfile, { merge: true });
      await publicProfileRef(user.uid).set({
        displayName: safeProfile.displayName,
        displayNameLower: String(safeProfile.displayName || "").toLowerCase(),
        username: safeProfile.username,
        usernameLower: safeProfile.username,
        email: user.email || "",
        photoURL: safeProfile.photoURL,
        gradeLevel: safeProfile.gradeLevel,
        strand: safeProfile.strand,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return safeProfile;
    },
    getProfile: async user => {
      const snapshot = await profileRef(user).get();
      return snapshot.exists ? snapshot.data() : {};
    },
    createShare: async (user, deck) => {
      const shareRef = db.collection("sharedDecks").doc();
      await shareRef.set({
        ownerId: user.uid,
        title: deck.title || "Shared Reviewer Deck",
        cards: deck.cards || [],
        subjectMode: deck.subjectMode || "general",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return shareRef.id;
    },
    getSharedDeck: async shareId => {
      const snapshot = await db.collection("sharedDecks").doc(shareId).get();
      return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
    },
    getPublicProfile: async uid => {
      const snapshot = await publicProfileRef(uid).get();
      return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
    },
    searchUsers: async (query, currentUser) => {
      const normalized = String(query || "").trim().toLowerCase();
      if (normalized.length < 2) return [];
      const snapshot = await db.collection("publicProfiles")
        .orderBy("displayNameLower")
        .startAt(normalized)
        .endAt(`${normalized}\uf8ff`)
        .limit(20)
        .get();
      return snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(profile => profile.id !== currentUser.uid);
    },
    sendFriendRequest: async (user, target) => {
      const targetId = getRecipientId(target);
      const requestId = `${user.uid}_${targetId}`;
      const requestRef = db.collection("friendRequests").doc(requestId);
      const senderSnapshot = await publicProfileRef(user.uid).get();
      const senderProfile = senderSnapshot.exists ? senderSnapshot.data() : {};
      const fallbackName = visibleAccountName(user.email);
      await requestRef.set({
        fromId: user.uid,
        toId: targetId,
        fromName: visibleAccountName(senderProfile.displayName, senderProfile.username, user.displayName, fallbackName),
        toName: target.displayName || "Paduan",
        participants: [user.uid, targetId],
        status: "pending",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    },
    listFriendRequests: async user => {
      const snapshot = await db.collection("friendRequests")
        .where("participants", "array-contains", user.uid)
        .limit(50)
        .get();
      const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(request => request.toId === user.uid && request.status === "pending");
      return Promise.all(requests.map(async request => {
        const profile = await publicProfileRef(request.fromId).get();
        const data = profile.exists ? profile.data() : {};
        const fallbackName = visibleAccountName(request.fromName);
        return {
          ...request,
          fromName: visibleAccountName(data.displayName, data.username, request.fromName, fallbackName),
          fromUsername: data.username || ""
        };
      }));
    },
    listOutgoingFriendRequests: async user => {
      const snapshot = await db.collection("friendRequests")
        .where("participants", "array-contains", user.uid)
        .limit(50)
        .get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(request => request.fromId === user.uid && request.status === "pending");
    },
    respondToFriendRequest: async (requestId, status) => {
      if (!["accepted", "rejected"].includes(status)) throw new Error("Invalid friend request response.");
      await db.collection("friendRequests").doc(requestId).update({ status });
    },
    removeFriend: requestId => db.collection("friendRequests").doc(requestId).delete(),
    listFriends: async user => {
      const snapshot = await db.collection("friendRequests")
        .where("participants", "array-contains", user.uid)
        .limit(100)
        .get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(friend => friend.status === "accepted");
    }
  };
})();
