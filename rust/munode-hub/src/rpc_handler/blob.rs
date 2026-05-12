use super::*;

impl RpcHandler {
    /// Maximum blob payload accepted from an Edge (bytes).
    /// Mumble avatars (textures) are capped at 600×60 JPEG ≈ 128 KiB in practice;
    /// comments are plain text.  1 MiB gives comfortable headroom while preventing
    /// a rogue or compromised Edge from filling the Hub's disk.
    const MAX_BLOB_BYTES: usize = 1024 * 1024; // 1 MiB

    pub(super) async fn handle_blob_put(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_put.as_ref().context("Missing blob_put params")?;
        if params.data.len() > Self::MAX_BLOB_BYTES {
            return Ok(self.make_response_packet(request_id, "blob.put", |r| {
                r.blob_put = Some(BlobPutResult {
                    success: false, hash: None,
                    error: Some(format!("Blob too large: {} bytes (max {})", params.data.len(), Self::MAX_BLOB_BYTES)),
                });
            }));
        };
        match self.state.blob_store.put_async(params.data.clone()).await {
            Ok(hash) => Ok(self.make_response_packet(request_id, "blob.put", |r| {
                r.blob_put = Some(BlobPutResult { success: true, hash: Some(hash), error: None });
            })),
            Err(e) => Ok(self.make_response_packet(request_id, "blob.put", |r| {
                r.blob_put = Some(BlobPutResult { success: false, hash: None, error: Some(e.to_string()) });
            })),
        }
    }

    pub(super) async fn handle_blob_get(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_get.as_ref().context("Missing blob_get params")?;
        match self.state.blob_store.get_async(params.hash.clone()).await {
            Ok(Some(data)) => Ok(self.make_response_packet(request_id, "blob.get", |r| {
                r.blob_get = Some(BlobGetResult { success: true, data: Some(data), error: None });
            })),
            Ok(None) => Ok(self.make_response_packet(request_id, "blob.get", |r| {
                r.blob_get = Some(BlobGetResult { success: false, data: None, error: Some("Not found".into()) });
            })),
            Err(e) => Ok(self.make_response_packet(request_id, "blob.get", |r| {
                r.blob_get = Some(BlobGetResult { success: false, data: None, error: Some(e.to_string()) });
            })),
        }
    }

    pub(super) async fn handle_blob_get_user_texture(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_get_user_texture.as_ref().context("Missing blob_get_user_texture params")?;
        let hash_opt = self.state.user_store.get_blob_hash(params.user_id, "texture").await?;
        match hash_opt {
            Some(hash) => {
                match self.state.blob_store.get_async(hash.clone()).await {
                    Ok(Some(data)) => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                        r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                            success: true, data: Some(data), hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Ok(None) => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                        r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                            success: false, data: None, hash: None, error: Some("Blob data not found".into()),
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                        r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                            success: false, data: None, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            None => Ok(self.make_response_packet(request_id, "blob.getUserTexture", |r| {
                r.blob_get_user_texture = Some(BlobGetUserTextureResult {
                    success: false, data: None, hash: None, error: Some("Not found".into()),
                });
            })),
        }
    }

    pub(super) async fn handle_blob_get_user_comment(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_get_user_comment.as_ref().context("Missing blob_get_user_comment params")?;
        let hash_opt = self.state.user_store.get_blob_hash(params.user_id, "comment").await?;
        match hash_opt {
            Some(hash) => {
                match self.state.blob_store.get_async(hash.clone()).await {
                    Ok(Some(data)) => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                        r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                            success: true, data: Some(data), hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Ok(None) => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                        r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                            success: false, data: None, hash: None, error: Some("Blob data not found".into()),
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                        r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                            success: false, data: None, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            None => Ok(self.make_response_packet(request_id, "blob.getUserComment", |r| {
                r.blob_get_user_comment = Some(BlobGetUserCommentResult {
                    success: false, data: None, hash: None, error: Some("Not found".into()),
                });
            })),
        }
    }

    pub(super) async fn handle_blob_set_user_texture(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_set_user_texture.as_ref().context("Missing blob_set_user_texture params")?;
        if params.data.len() > Self::MAX_BLOB_BYTES {
            return Ok(self.make_response_packet(request_id, "blob.setUserTexture", |r| {
                r.blob_set_user_texture = Some(BlobSetUserTextureResult {
                    success: false, hash: None,
                    error: Some(format!("Blob too large: {} bytes (max {})", params.data.len(), Self::MAX_BLOB_BYTES)),
                });
            }));
        };
        match self.state.blob_store.put_async(params.data.clone()).await {
            Ok(hash) => {
                match self.state.user_store.set_blob_hash(params.user_id, "texture", &hash).await {
                    Ok(()) => Ok(self.make_response_packet(request_id, "blob.setUserTexture", |r| {
                        r.blob_set_user_texture = Some(BlobSetUserTextureResult {
                            success: true, hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserTexture", |r| {
                        r.blob_set_user_texture = Some(BlobSetUserTextureResult {
                            success: false, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserTexture", |r| {
                r.blob_set_user_texture = Some(BlobSetUserTextureResult {
                    success: false, hash: None, error: Some(e.to_string()),
                });
            })),
        }
    }

    pub(super) async fn handle_blob_set_user_comment(
        &self,
        request: &TypedRpcRequest,
        request_id: &str,
    ) -> Result<EdgeHubPacket> {
        let params = request.blob_set_user_comment.as_ref().context("Missing blob_set_user_comment params")?;
        if params.data.len() > Self::MAX_BLOB_BYTES {
            return Ok(self.make_response_packet(request_id, "blob.setUserComment", |r| {
                r.blob_set_user_comment = Some(BlobSetUserCommentResult {
                    success: false, hash: None,
                    error: Some(format!("Blob too large: {} bytes (max {})", params.data.len(), Self::MAX_BLOB_BYTES)),
                });
            }));
        };
        match self.state.blob_store.put_async(params.data.clone()).await {
            Ok(hash) => {
                match self.state.user_store.set_blob_hash(params.user_id, "comment", &hash).await {
                    Ok(()) => Ok(self.make_response_packet(request_id, "blob.setUserComment", |r| {
                        r.blob_set_user_comment = Some(BlobSetUserCommentResult {
                            success: true, hash: Some(hash.clone()), error: None,
                        });
                    })),
                    Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserComment", |r| {
                        r.blob_set_user_comment = Some(BlobSetUserCommentResult {
                            success: false, hash: None, error: Some(e.to_string()),
                        });
                    })),
                }
            }
            Err(e) => Ok(self.make_response_packet(request_id, "blob.setUserComment", |r| {
                r.blob_set_user_comment = Some(BlobSetUserCommentResult {
                    success: false, hash: None, error: Some(e.to_string()),
                });
            })),
        }
    }
}