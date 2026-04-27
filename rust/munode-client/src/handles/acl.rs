//! Channel ACL editor — wraps the `Acl` protobuf message with edit helpers.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use munode_protocol::message_type::MessageType;
use munode_protocol::mumbleproto;
use tokio::time::timeout;

use crate::client::MumbleClient;
use crate::events::ClientEvent;

/// ACL handle for a single channel — load, edit, save.
#[derive(Clone)]
pub struct Acl<'a> {
    pub(crate) client: &'a MumbleClient,
    pub(crate) channel_id: u32,
}

impl<'a> Acl<'a> {
    /// Send an `ACL` query — the response will arrive as `ClientEvent::Acl`.
    pub async fn request(&self) -> Result<()> {
        self.client.send_proto(MessageType::Acl, &mumbleproto::Acl {
            channel_id: self.channel_id,
            query: Some(true),
            ..Default::default()
        })
    }

    /// Query and await the ACL message.
    pub async fn fetch(&self, wait: Duration) -> Result<mumbleproto::Acl> {
        let mut sub = self.client.subscribe();
        self.request().await?;
        let id = self.channel_id;
        timeout(wait, async move {
            loop {
                match sub.recv().await {
                    Ok(ClientEvent::Acl(acl)) if acl.channel_id == id => return Ok(*acl),
                    Ok(_) => continue,
                    Err(e) => return Err(anyhow!("event channel: {e}")),
                }
            }
        })
        .await
        .context("timeout waiting for ACL")?
    }

    /// Save a complete ACL definition (replaces existing groups/entries).
    pub async fn save(&self, mut acl: mumbleproto::Acl) -> Result<()> {
        acl.channel_id = self.channel_id;
        acl.query = Some(false);
        self.client.send_proto(MessageType::Acl, &acl)
    }

    /// Append an entry, then save (load → push → save round-trip).
    pub async fn add_entry(
        &self,
        entry: mumbleproto::acl::ChanAcl,
        wait: Duration,
    ) -> Result<()> {
        let mut acl = self.fetch(wait).await?;
        acl.acls.push(entry);
        self.save(acl).await
    }

    /// Remove the entry at `index` (load → remove → save round-trip).
    pub async fn remove_entry(&self, index: usize, wait: Duration) -> Result<()> {
        let mut acl = self.fetch(wait).await?;
        if index >= acl.acls.len() {
            return Err(anyhow!("ACL entry index {} out of range", index));
        }
        acl.acls.remove(index);
        self.save(acl).await
    }

    /// Add or replace a channel group (load → upsert → save round-trip).
    pub async fn upsert_group(
        &self,
        group: mumbleproto::acl::ChanGroup,
        wait: Duration,
    ) -> Result<()> {
        let mut acl = self.fetch(wait).await?;
        if let Some(slot) = acl.groups.iter_mut().find(|g| g.name == group.name) {
            *slot = group;
        } else {
            acl.groups.push(group);
        }
        self.save(acl).await
    }

    /// Remove a group by name (load → filter → save round-trip).
    pub async fn remove_group(&self, name: &str, wait: Duration) -> Result<()> {
        let mut acl = self.fetch(wait).await?;
        acl.groups.retain(|g| g.name != name);
        self.save(acl).await
    }

    /// Add a user to the named group (creates the group if necessary).
    pub async fn add_user_to_group(
        &self,
        group_name: &str,
        user_id: u32,
        wait: Duration,
    ) -> Result<()> {
        let mut acl = self.fetch(wait).await?;
        let group = acl
            .groups
            .iter_mut()
            .find(|g| g.name == group_name);
        match group {
            Some(g) => {
                if !g.add.contains(&user_id) {
                    g.add.push(user_id);
                }
                g.remove.retain(|id| *id != user_id);
            }
            None => {
                acl.groups.push(mumbleproto::acl::ChanGroup {
                    name: group_name.to_owned(),
                    inherited: Some(false),
                    inherit: Some(true),
                    inheritable: Some(true),
                    add: vec![user_id],
                    remove: vec![],
                    inherited_members: vec![],
                });
            }
        }
        self.save(acl).await
    }

    /// Remove a user from the named group.
    pub async fn remove_user_from_group(
        &self,
        group_name: &str,
        user_id: u32,
        wait: Duration,
    ) -> Result<()> {
        let mut acl = self.fetch(wait).await?;
        if let Some(g) = acl.groups.iter_mut().find(|g| g.name == group_name) {
            g.add.retain(|id| *id != user_id);
            if !g.remove.contains(&user_id) {
                g.remove.push(user_id);
            }
            self.save(acl).await
        } else {
            Err(anyhow!("group {} not found on channel {}", group_name, self.channel_id))
        }
    }
}
