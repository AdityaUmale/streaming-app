'use client';

import { useCallback, useRef, useState } from 'react';

interface MediaDevices {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
}

interface StreamState {
  video: boolean;
  audio: boolean;
}

export const useMediaStream = () => {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDevices>({ cameras: [], microphones: [] });
  const [streamState, setStreamState] = useState<StreamState>({ video: false, audio: false });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);

  const getDevices = useCallback(async () => {
    try {
      console.log('🎬 Getting media devices...');
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(device => device.kind === 'videoinput');
      const microphones = devices.filter(device => device.kind === 'audioinput');
      
      setDevices({ cameras, microphones });
      console.log('📱 Found devices:', { cameras: cameras.length, microphones: microphones.length });
      
      return { cameras, microphones };
    } catch (err) {
      console.error('❌ Failed to get devices:', err);
      setError('Failed to access media devices');
      throw err;
    }
  }, []);

  const startStream = useCallback(async (constraints: { video?: boolean | MediaTrackConstraints, audio?: boolean | MediaTrackConstraints } = { video: true, audio: true }) => {
    try {
      setIsLoading(true);
      setError(null);
      
      console.log('🎥 Starting media stream...', constraints);
      
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      streamRef.current = mediaStream;
      setStream(mediaStream);
      
      setStreamState({
        video: mediaStream.getVideoTracks().length > 0,
        audio: mediaStream.getAudioTracks().length > 0
      });
      
      console.log('✅ Media stream started:', {
        video: mediaStream.getVideoTracks().length,
        audio: mediaStream.getAudioTracks().length
      });
      
      // Update devices list after getting permissions
      await getDevices();
      
      return mediaStream;
    } catch (err) {
      console.error('❌ Failed to start stream:', err);
      let errorMessage = 'Failed to access camera/microphone';
      
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          errorMessage = 'Camera/microphone access denied. Please allow permissions.';
        } else if (err.name === 'NotFoundError') {
          errorMessage = 'No camera/microphone found.';
        } else if (err.name === 'NotReadableError') {
          errorMessage = 'Camera/microphone is already in use.';
        }
      }
      
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [getDevices]);

  const stopStream = useCallback(() => {
    console.log('🛑 Stopping media stream...');
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log(`🔇 Stopped ${track.kind} track`);
      });
      
      streamRef.current = null;
      setStream(null);
      setStreamState({ video: false, audio: false });
    }
  }, []);

  const toggleVideo = useCallback(async () => {
    if (!streamRef.current) return;
    
    const videoTrack = streamRef.current.getVideoTracks()[0];
    
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setStreamState(prev => ({ ...prev, video: videoTrack.enabled }));
      console.log(`📹 Video ${videoTrack.enabled ? 'enabled' : 'disabled'}`);
    } else if (!streamState.video) {
      // Re-add video track
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const newVideoTrack = newStream.getVideoTracks()[0];
        
        if (newVideoTrack) {
          streamRef.current.addTrack(newVideoTrack);
          setStream(streamRef.current);
          setStreamState(prev => ({ ...prev, video: true }));
          console.log('📹 Video track re-added');
        }
      } catch (err) {
        console.error('❌ Failed to re-add video:', err);
        setError('Failed to enable video');
      }
    }
  }, [streamState.video]);

  const toggleAudio = useCallback(() => {
    if (!streamRef.current) return;
    
    const audioTrack = streamRef.current.getAudioTracks()[0];
    
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setStreamState(prev => ({ ...prev, audio: audioTrack.enabled }));
      console.log(`🎤 Audio ${audioTrack.enabled ? 'enabled' : 'disabled'}`);
    }
  }, []);

  const switchCamera = useCallback(async (deviceId: string) => {
    if (!streamRef.current) return;
    
    try {
      console.log('📷 Switching camera to:', deviceId);
      
      // Stop current video track
      const videoTrack = streamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.stop();
        streamRef.current.removeTrack(videoTrack);
      }
      
      // Get new video stream with specific device
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } }
      });
      
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (newVideoTrack) {
        streamRef.current.addTrack(newVideoTrack);
        setStream(streamRef.current);
        console.log('✅ Camera switched successfully');
      }
    } catch (err) {
      console.error('❌ Failed to switch camera:', err);
      setError('Failed to switch camera');
    }
  }, []);

  const getVideoTrack = useCallback(() => {
    return stream?.getVideoTracks()[0] || null;
  }, [stream]);

  const getAudioTrack = useCallback(() => {
    return stream?.getAudioTracks()[0] || null;
  }, [stream]);

  return {
    stream,
    devices,
    streamState,
    error,
    isLoading,
    getDevices,
    startStream,
    stopStream,
    toggleVideo,
    toggleAudio,
    switchCamera,
    getVideoTrack,
    getAudioTrack
  };
};