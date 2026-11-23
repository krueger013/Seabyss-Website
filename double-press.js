export function createDoublePress() {
  let previous;
  return {
    press({clientX:x,clientY:y,pointerType,timeStamp}) {
      const tolerance = pointerType === 'touch' ? 24 : 12;
      const double = previous && timeStamp>=previous.time && timeStamp-previous.time<=340 &&
        previous.type===pointerType && Math.hypot(x-previous.x,y-previous.y)<=tolerance;
      previous = double ? undefined : {x,y,time:timeStamp,type:pointerType};
      return Boolean(double);
    },
    reset() {previous=undefined;}
  };
}
